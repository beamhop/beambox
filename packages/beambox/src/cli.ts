#!/usr/bin/env node
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { BuildEvent } from "@beamhop/builder"
import { BeamboxError } from "@beamhop/oci"
import { dockerfile } from "./dockerfile.ts"
import type { BuiltImage } from "./result.ts"

const USAGE = `beambox — build OCI images for microsandbox, without Docker

Usage:
  beambox build [options] <context>     Build an image from a Dockerfile
  beambox version                       Print the version

Build options:
  -f, --file <path>        Dockerfile to build (default: <context>/Dockerfile)
  -t, --tag <ref>          Tag the image; repeatable
      --target <stage>     Build only up to this stage
      --build-arg <k=v>    Set a build argument; repeatable
      --platform <p>       Target platform, e.g. linux/arm64
  -o, --output <path>      Write a tar archive
      --format <fmt>       Archive format: docker (default) or oci
      --layout <dir>       Write an unpacked OCI layout directory
      --load               Load into the local microsandbox image cache
      --push               Push to the registry named by the first --tag
      --no-cache           Ignore cached RUN results
      --insecure           Use plain HTTP for registries
  -q, --quiet              Only print errors

With no output option, beambox --load's the image so it is ready for msb run.

Examples:
  beambox build -t app:local .
  beambox build -t app:local --output app.tar .
  beambox build -t ghcr.io/me/app:v1 --push .
`

const RESET = "\u001b[0m"
const DIM = "\u001b[2m"
const BOLD = "\u001b[1m"
const RED = "\u001b[31m"
const GREEN = "\u001b[32m"

const supportsColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined
const style = (code: string, text: string): string =>
  supportsColor ? `${code}${text}${RESET}` : text

const reporter = (quiet: boolean) => {
  let stage = 0
  return (event: BuildEvent): void => {
    if (quiet) return
    switch (event.kind) {
      case "stage":
        stage = event.index + 1
        if (event.total > 1) {
          process.stderr.write(style(BOLD, `\nstage ${stage}/${event.total} (${event.name})\n`))
        }
        break
      case "pull":
        process.stderr.write(style(DIM, `  pulling ${event.reference}\n`))
        break
      case "step":
        process.stderr.write(
          `  ${style(DIM, `[${event.index + 1}/${event.total}]`)} ${event.instruction}\n`,
        )
        break
      case "cached":
        process.stderr.write(style(DIM, `        cached\n`))
        break
      case "output":
        for (const line of event.text.split("\n")) {
          if (line !== "") process.stderr.write(style(DIM, `        ${line}\n`))
        }
        break
      case "warning":
        process.stderr.write(style(RED, `  warning: ${event.message}\n`))
        break
    }
  }
}

const parseBuildArgs = (values: readonly string[]): Record<string, string> => {
  const args: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf("=")
    if (separator <= 0) {
      // A bare `--build-arg FOO` forwards the value from the environment, as docker does.
      const fromEnv = process.env[entry]
      if (fromEnv === undefined) {
        throw new Error(
          `--build-arg ${entry} has no value and ${entry} is not set in the environment`,
        )
      }
      args[entry] = fromEnv
      continue
    }
    args[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return args
}

const parsePlatform = (value: string) => {
  const [os, architecture, variant] = value.split("/")
  if (os === undefined || architecture === undefined) {
    throw new Error(`--platform ${value} should look like linux/arm64`)
  }
  return { os, architecture, ...(variant !== undefined ? { variant } : {}) }
}

const runBuild = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f" },
      tag: { type: "string", short: "t", multiple: true },
      target: { type: "string" },
      "build-arg": { type: "string", multiple: true },
      platform: { type: "string" },
      output: { type: "string", short: "o" },
      format: { type: "string" },
      layout: { type: "string" },
      load: { type: "boolean" },
      push: { type: "boolean" },
      "no-cache": { type: "boolean" },
      insecure: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
    },
  })

  const context = resolve(positionals[0] ?? ".")
  const dockerfilePath =
    values.file !== undefined ? resolve(values.file) : join(context, "Dockerfile")
  const tags = values.tag ?? []
  const quiet = values.quiet === true

  if (values.format !== undefined && values.format !== "docker" && values.format !== "oci") {
    throw new Error(`--format must be "docker" or "oci", not ${JSON.stringify(values.format)}`)
  }
  if (values.push === true && tags.length === 0) {
    throw new Error(`--push needs a --tag naming where to push, e.g. -t ghcr.io/me/app:v1`)
  }

  const started = Date.now()
  const source = await dockerfile(dockerfilePath, { context })

  const built: BuiltImage = await source.build({
    tags,
    onProgress: reporter(quiet),
    ...(values.target !== undefined ? { target: values.target } : {}),
    ...(values.platform !== undefined ? { platform: parsePlatform(values.platform) } : {}),
    ...(values["build-arg"] !== undefined
      ? { buildArgs: parseBuildArgs(values["build-arg"]) }
      : {}),
    ...(values["no-cache"] === true ? { noCache: true } : {}),
    ...(values.insecure === true ? { registry: { insecure: true } } : {}),
  })

  const done: string[] = []

  if (values.output !== undefined) {
    await built.toArchive(values.output, {
      ...(values.format === "oci" ? { format: "oci" as const } : {}),
    })
    done.push(`wrote ${values.output}`)
  }
  if (values.layout !== undefined) {
    await built.toLayoutDirectory(values.layout)
    done.push(`wrote ${values.layout}/`)
  }
  if (values.push === true) {
    const target = tags[0] ?? ""
    const digest = await built.push(target, {
      ...(values.insecure === true ? { insecure: true } : {}),
    })
    done.push(`pushed ${target} (${digest.slice(0, 19)}…)`)
  }

  // With no explicit destination, the useful default is the thing microsandbox can run.
  const shouldLoad =
    values.load === true ||
    (values.output === undefined && values.layout === undefined && values.push !== true)

  if (shouldLoad) {
    const loaded = await built.load()
    done.push(`loaded ${loaded.map((image) => image.reference).join(", ") || "(untagged)"}`)
  }

  if (!quiet) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    process.stderr.write(
      `\n${style(GREEN, "✓")} built ${built.layers.length} layers in ${seconds}s\n`,
    )
    for (const line of done) process.stderr.write(`  ${line}\n`)
  }

  process.stdout.write(`${built.manifestDescriptor.digest}\n`)
  return 0
}

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case "build":
      return await runBuild(rest)
    case "version":
    case "--version":
    case "-v":
      process.stdout.write("beambox 0.1.0\n")
      return 0
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE)
      return command === undefined ? 1 : 0
    default:
      process.stderr.write(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`)
      return 1
  }
}

try {
  process.exit(await main())
} catch (error) {
  // Typed beambox errors already explain themselves; anything else gets a stack.
  if (error instanceof BeamboxError) {
    process.stderr.write(`\n${style(RED, "error")} ${error.message}\n`)
  } else {
    process.stderr.write(
      `\n${style(RED, "error")} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
  }
  process.exit(1)
}
