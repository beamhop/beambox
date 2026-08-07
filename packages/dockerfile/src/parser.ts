import type { BuildOp, BuildPlan, Command, RunMount, Stage } from "@beambox/builder"
import type { Platform } from "@beambox/oci"
import { DockerfileParseError, UnsupportedInstructionError } from "./errors.ts"
import { type LogicalLine, lex, parseExecForm, splitWords, takeFlags } from "./lexer.ts"

/** Instructions beambox recognises but deliberately refuses, with the reason why. */
const REFUSED: Record<string, string> = {
  ONBUILD:
    "Triggers that fire in a downstream build have no equivalent here. Move the work into " +
    "the downstream Dockerfile.",
  MAINTAINER:
    "MAINTAINER has been deprecated since Docker 1.13. Use " +
    'LABEL org.opencontainers.image.authors="…" instead.',
}

const KNOWN = new Set([
  "FROM",
  "RUN",
  "CMD",
  "LABEL",
  "EXPOSE",
  "ENV",
  "ADD",
  "COPY",
  "ENTRYPOINT",
  "VOLUME",
  "USER",
  "WORKDIR",
  "ARG",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
  "ONBUILD",
  "MAINTAINER",
])

const parsePlatform = (value: string, line: LogicalLine): Platform => {
  const [os, architecture, variant] = value.split("/")
  if (os === undefined || architecture === undefined) {
    throw new DockerfileParseError(
      line.line,
      `--platform=${value} should look like linux/amd64`,
      line.source,
    )
  }
  return { os, architecture, ...(variant !== undefined ? { variant } : {}) }
}

/** `key=value key2="value two"` pairs, or the legacy `ENV key value` form. */
const parsePairs = (line: LogicalLine, allowLegacy: boolean): Record<string, string> => {
  const words = splitWords(line.args)
  if (words.length === 0) {
    throw new DockerfileParseError(
      line.line,
      `${line.instruction} needs at least one value`,
      line.source,
    )
  }

  const hasEquals = words.some((word) => word.includes("="))
  if (!hasEquals) {
    if (!allowLegacy) {
      throw new DockerfileParseError(
        line.line,
        `${line.instruction} expects key=value pairs`,
        line.source,
      )
    }
    // `ENV KEY the rest of the line` — everything after the key is the value.
    const [key = "", ...rest] = words
    return { [key]: rest.join(" ") }
  }

  const values: Record<string, string> = {}
  for (const word of words) {
    const separator = word.indexOf("=")
    if (separator <= 0) {
      throw new DockerfileParseError(
        line.line,
        `${JSON.stringify(word)} is not a key=value pair`,
        line.source,
      )
    }
    values[word.slice(0, separator)] = word.slice(separator + 1)
  }
  return values
}

/** `--mount=type=cache,target=/root/.cache,id=npm` */
const parseMount = (value: string, line: LogicalLine): RunMount => {
  const fields = new Map<string, string>()
  for (const part of value.split(",")) {
    const separator = part.indexOf("=")
    if (separator === -1) fields.set(part.trim(), "true")
    else fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }

  const type = fields.get("type") ?? "bind"
  const target = fields.get("target") ?? fields.get("dst") ?? fields.get("destination")
  if (target === undefined) {
    throw new DockerfileParseError(line.line, `--mount needs a target=`, line.source)
  }

  if (type === "secret" || type === "ssh") {
    throw new UnsupportedInstructionError(
      `RUN --mount=type=${type}`,
      line.line,
      `beambox does not forward host secrets or SSH agents into a build. Pass values with ` +
        `--build-arg, or bake them in at run time where they are not recorded in a layer.`,
    )
  }
  if (type === "cache") {
    const id = fields.get("id")
    return {
      type: "cache",
      target,
      ...(id !== undefined ? { id } : {}),
      ...(fields.has("readonly") || fields.has("ro") ? { readonly: true } : {}),
    }
  }
  if (type === "tmpfs") return { type: "tmpfs", target }
  if (type === "bind") {
    const source = fields.get("source") ?? fields.get("src")
    const from = fields.get("from")
    return {
      type: "bind",
      target,
      ...(source !== undefined ? { source } : {}),
      ...(from !== undefined ? { from } : {}),
    }
  }

  throw new UnsupportedInstructionError(
    `RUN --mount=type=${type}`,
    line.line,
    `Supported mount types are cache, bind, and tmpfs.`,
  )
}

/** A command in either form, with heredoc bodies substituted in. */
const parseCommand = (line: LogicalLine, args: string): Command => {
  const exec = parseExecForm(args)
  if (exec) return { form: "exec", argv: exec }

  if (line.heredocs.size > 0) {
    // `RUN <<EOF … EOF` runs the body as the script; the redirect itself is not the command.
    const body = [...line.heredocs.values()].join("\n")
    return { form: "shell", command: body }
  }
  return { form: "shell", command: args }
}

const parseHealthcheck = (line: LogicalLine): BuildOp => {
  const words = splitWords(line.args)
  if (words[0]?.toUpperCase() === "NONE") return { kind: "healthcheck", test: null }

  const { flags, rest } = takeFlags(words)
  const duration = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim())
    if (!match) return undefined
    const amount = Number(match[1])
    const unit = match[2] ?? "s"
    const nanos = { ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12 }[unit] ?? 1e9
    return amount * nanos
  }

  if (rest[0]?.toUpperCase() !== "CMD") {
    throw new DockerfileParseError(line.line, `HEALTHCHECK expects CMD or NONE`, line.source)
  }

  const commandArgs = line.args.slice(line.args.toUpperCase().indexOf("CMD") + 3).trim()
  const exec = parseExecForm(commandArgs)
  const interval = duration(flags.get("interval"))
  const timeout = duration(flags.get("timeout"))
  const startPeriod = duration(flags.get("start-period"))
  const retries = flags.get("retries") !== undefined ? Number(flags.get("retries")) : undefined

  return {
    kind: "healthcheck",
    test: exec ? ["CMD", ...exec] : ["CMD-SHELL", commandArgs],
    ...(interval !== undefined ? { interval } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(startPeriod !== undefined ? { startPeriod } : {}),
    ...(retries !== undefined && !Number.isNaN(retries) ? { retries } : {}),
  }
}

const parseCopy = (line: LogicalLine, kind: "copy" | "add"): BuildOp => {
  const { flags, rest } = takeFlags(splitWords(line.args))
  if (rest.length < 2) {
    throw new DockerfileParseError(
      line.line,
      `${line.instruction} needs at least one source and a destination`,
      line.source,
    )
  }

  for (const flag of flags.keys()) {
    if (!["from", "chown", "chmod", "link", "parents", "exclude"].includes(flag)) {
      throw new UnsupportedInstructionError(
        `${line.instruction} --${flag}`,
        line.line,
        `Supported flags are --from, --chown, and --chmod.`,
      )
    }
  }

  const destination = rest[rest.length - 1] ?? ""
  const sources = rest.slice(0, -1)
  const from = flags.get("from")
  const chown = flags.get("chown")
  const chmod = flags.get("chmod")

  return {
    kind,
    sources,
    destination,
    ...(from !== undefined ? { from } : {}),
    ...(chown !== undefined ? { chown } : {}),
    ...(chmod !== undefined ? { chmod } : {}),
  }
}

const parseRun = (line: LogicalLine): BuildOp => {
  // Flags come before the command, and only the JSON form has no flags at all.
  const words = splitWords(line.args)
  const { flags } = takeFlags(words)

  const mounts: RunMount[] = []
  for (const [key, value] of flags) {
    if (key === "mount") mounts.push(parseMount(value, line))
    else if (key === "network" || key === "security") {
      throw new UnsupportedInstructionError(
        `RUN --${key}`,
        line.line,
        `beambox runs every step in an isolated microVM with fixed settings.`,
      )
    }
  }

  // Strip the flags from the raw argument text so the command survives verbatim.
  let commandText = line.args
  for (const [key, value] of flags) {
    commandText = commandText.replace(`--${key}=${value}`, "").trimStart()
  }

  return {
    kind: "run",
    command: parseCommand(line, commandText.trim()),
    ...(mounts.length > 0 ? { mounts } : {}),
  }
}

/**
 * Parse Dockerfile text into a build plan.
 *
 * Every instruction is either translated or rejected by name and line number — nothing is
 * quietly dropped, because an instruction that silently does nothing produces an image
 * that looks correct and behaves wrongly.
 */
export const parseDockerfile = (text: string, options: { context?: string } = {}): BuildPlan => {
  const { lines, syntax } = lex(text)

  if (syntax !== undefined && !/^docker\/dockerfile/.test(syntax)) {
    throw new UnsupportedInstructionError(
      `# syntax=${syntax}`,
      1,
      `beambox implements the standard Dockerfile syntax only, not custom BuildKit frontends.`,
    )
  }

  const stages: Stage[] = []
  /** `ARG`s declared before the first `FROM` are visible to every stage's `FROM`. */
  const globalArgs: Record<string, string> = {}
  let current:
    | { name?: string; base: Stage["base"]; platform?: Platform; ops: BuildOp[] }
    | undefined

  const push = (): void => {
    if (!current) return
    stages.push({
      ...(current.name !== undefined ? { name: current.name } : {}),
      base: current.base,
      ops: current.ops,
      ...(current.platform !== undefined ? { platform: current.platform } : {}),
    })
  }

  const requireStage = (line: LogicalLine): NonNullable<typeof current> => {
    if (!current) {
      throw new DockerfileParseError(
        line.line,
        `${line.instruction} appears before any FROM instruction`,
        line.source,
      )
    }
    return current
  }

  for (const line of lines) {
    if (!KNOWN.has(line.instruction)) {
      throw new DockerfileParseError(
        line.line,
        `unknown instruction ${line.instruction}`,
        line.source,
      )
    }

    const refusal = REFUSED[line.instruction]
    if (refusal !== undefined) {
      throw new UnsupportedInstructionError(line.instruction, line.line, refusal)
    }

    switch (line.instruction) {
      case "FROM": {
        push()
        const { flags, rest } = takeFlags(splitWords(line.args))
        const reference = rest[0]
        if (reference === undefined) {
          throw new DockerfileParseError(line.line, `FROM needs an image`, line.source)
        }

        let name: string | undefined
        if (rest.length >= 3 && rest[1]?.toUpperCase() === "AS") name = rest[2]
        else if (rest.length === 2) {
          throw new DockerfileParseError(
            line.line,
            `FROM ${reference} ${rest[1]} — did you mean "AS ${rest[1]}"?`,
            line.source,
          )
        }

        // A bare name matching an earlier stage refers to that stage, not a registry.
        const earlier = stages.find((stage) => stage.name === reference)
        const platformFlag = flags.get("platform")

        current = {
          ...(name !== undefined ? { name } : {}),
          base:
            reference === "scratch"
              ? { kind: "scratch" }
              : earlier
                ? { kind: "stage", stage: reference }
                : { kind: "registry", reference },
          ops: [],
          ...(platformFlag !== undefined ? { platform: parsePlatform(platformFlag, line) } : {}),
        }
        break
      }

      case "ARG": {
        const words = splitWords(line.args)
        const first = words[0]
        if (first === undefined) {
          throw new DockerfileParseError(line.line, `ARG needs a name`, line.source)
        }
        const separator = first.indexOf("=")
        const name = separator === -1 ? first : first.slice(0, separator)
        const defaultValue = separator === -1 ? undefined : first.slice(separator + 1)

        if (!current) {
          globalArgs[name] = defaultValue ?? ""
          break
        }
        current.ops.push({
          kind: "arg",
          name,
          ...(defaultValue !== undefined ? { defaultValue } : {}),
        })
        break
      }

      case "RUN":
        requireStage(line).ops.push(parseRun(line))
        break

      case "COPY":
        requireStage(line).ops.push(parseCopy(line, "copy"))
        break

      case "ADD":
        requireStage(line).ops.push(parseCopy(line, "add"))
        break

      case "ENV":
        requireStage(line).ops.push({ kind: "env", values: parsePairs(line, true) })
        break

      case "LABEL":
        requireStage(line).ops.push({ kind: "label", values: parsePairs(line, false) })
        break

      case "WORKDIR":
        requireStage(line).ops.push({ kind: "workdir", path: splitWords(line.args)[0] ?? "/" })
        break

      case "USER":
        requireStage(line).ops.push({ kind: "user", user: splitWords(line.args)[0] ?? "root" })
        break

      case "CMD":
        requireStage(line).ops.push({ kind: "cmd", command: parseCommand(line, line.args) })
        break

      case "ENTRYPOINT":
        requireStage(line).ops.push({ kind: "entrypoint", command: parseCommand(line, line.args) })
        break

      case "EXPOSE":
        requireStage(line).ops.push({ kind: "expose", ports: splitWords(line.args) })
        break

      case "VOLUME": {
        const exec = parseExecForm(line.args)
        requireStage(line).ops.push({ kind: "volume", paths: exec ?? splitWords(line.args) })
        break
      }

      case "STOPSIGNAL":
        requireStage(line).ops.push({
          kind: "stopsignal",
          signal: splitWords(line.args)[0] ?? "SIGTERM",
        })
        break

      case "SHELL": {
        const exec = parseExecForm(line.args)
        if (!exec) {
          throw new DockerfileParseError(
            line.line,
            `SHELL must use the JSON form, for example SHELL ["/bin/bash", "-c"]`,
            line.source,
          )
        }
        requireStage(line).ops.push({ kind: "shell", shell: exec })
        break
      }

      case "HEALTHCHECK":
        requireStage(line).ops.push(parseHealthcheck(line))
        break

      default:
        throw new DockerfileParseError(
          line.line,
          `unhandled instruction ${line.instruction}`,
          line.source,
        )
    }
  }

  push()

  if (stages.length === 0) {
    throw new DockerfileParseError(1, `no FROM instruction found — nothing to build`)
  }

  return {
    stages,
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(Object.keys(globalArgs).length > 0 ? { buildArgs: globalArgs } : {}),
  }
}
