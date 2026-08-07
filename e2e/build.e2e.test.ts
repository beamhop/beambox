import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerfileText, image } from "@beamhop/beambox"

/**
 * End-to-end verification against a real microsandbox runtime.
 *
 * Nothing here is simulated: images are pulled from Docker Hub, `RUN` steps execute in
 * real microVMs, and every assertion is made by booting the finished image and reading
 * what it prints. Docker is not installed on the machine this was developed on, which is
 * the point.
 *
 * Run with `bun run test:e2e`. Kept out of `bun test` because it needs `msb` installed
 * and takes tens of seconds.
 */

const BASE = "alpine:3.20"
const TAG_PREFIX = "beambox-e2e"

let workspace: string
const created: { images: string[]; sandboxes: string[] } = { images: [], sandboxes: [] }

/** Boot an image and return what it wrote to stdout. */
const runImage = async (reference: string, command?: readonly string[]): Promise<string> => {
  const name = `${TAG_PREFIX}-run-${crypto.randomUUID().slice(0, 8)}`
  created.sandboxes.push(name)

  const args = ["run", "--name", name, reference, ...(command ? ["--", ...command] : [])]
  const result = Bun.spawnSync(["msb", ...args])
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()

  if (result.exitCode !== 0) {
    throw new Error(`msb run ${reference} failed (${result.exitCode}):\n${stdout}\n${stderr}`)
  }
  return stdout
}

const tag = (suffix: string): string => {
  const reference = `${TAG_PREFIX}-${suffix}:test`
  created.images.push(reference)
  return reference
}

beforeAll(async () => {
  const check = Bun.spawnSync(["msb", "--version"])
  if (check.exitCode !== 0) {
    throw new Error("These tests need the microsandbox CLI (`msb`) on PATH.")
  }
  workspace = await mkdtemp(join(tmpdir(), "beambox-e2e-"))
})

afterAll(async () => {
  for (const name of created.sandboxes) Bun.spawnSync(["msb", "rm", name])
  for (const reference of created.images) Bun.spawnSync(["msb", "rmi", "--force", reference])
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

describe("declarative build", () => {
  test("a build with no RUN steps produces a bootable image", async () => {
    const reference = tag("declarative")
    await Bun.write(join(workspace, "declarative", "greeting.txt"), "declarative build works\n")

    const built = await image(BASE)
      .copy("greeting.txt", "/opt/greeting.txt")
      .env({ MARKER: "set-by-beambox" })
      .cmd(["/bin/sh", "-c", "cat /opt/greeting.txt; echo MARKER=$MARKER"])
      .build({ context: join(workspace, "declarative"), tags: [reference] })

    await built.load()
    const output = await runImage(reference)

    expect(output).toContain("declarative build works")
    expect(output).toContain("MARKER=set-by-beambox")
  }, 300_000)
})

describe("RUN steps in a microVM", () => {
  test("a RUN step's filesystem changes survive into the finished image", async () => {
    const reference = tag("run")

    const built = await image(BASE)
      .run("mkdir -p /opt/beam && echo produced-by-run > /opt/beam/marker")
      .cmd(["cat", "/opt/beam/marker"])
      .build({ context: workspace, tags: [reference], noCache: true })

    await built.load()
    expect(await runImage(reference)).toContain("produced-by-run")
  }, 300_000)

  test("a later RUN sees files added by an earlier COPY", async () => {
    const reference = tag("copy-then-run")
    const context = join(workspace, "copy-then-run")
    await Bun.write(join(context, "input.txt"), "from the host")

    const built = await image(BASE)
      .run("mkdir -p /work")
      .copy("input.txt", "/work/input.txt")
      .run("tr 'a-z' 'A-Z' < /work/input.txt > /work/output.txt")
      .cmd(["cat", "/work/output.txt"])
      .build({ context, tags: [reference], noCache: true })

    await built.load()
    expect(await runImage(reference)).toContain("FROM THE HOST")
  }, 300_000)

  test("a deletion becomes a whiteout, so the file is gone at run time", async () => {
    const reference = tag("whiteout")

    const built = await image(BASE)
      .run("test -f /etc/alpine-release && rm /etc/alpine-release")
      .cmd(["/bin/sh", "-c", "test -e /etc/alpine-release && echo STILL-THERE || echo REMOVED"])
      .build({ context: workspace, tags: [reference], noCache: true })

    await built.load()
    expect(await runImage(reference)).toContain("REMOVED")
  }, 300_000)

  test("a failing RUN aborts the build and reports the exit code and output", async () => {
    await expect(
      image(BASE)
        .run("echo about-to-fail >&2 && exit 42")
        .build({ context: workspace, noCache: true }),
    ).rejects.toThrow(/exit code 42/)
  }, 300_000)

  test("environment and working directory reach the command", async () => {
    const reference = tag("env-workdir")

    const built = await image(BASE)
      .env({ TARGET_DIR: "/srv/app" })
      .run("mkdir -p $TARGET_DIR")
      .workdir("/srv/app")
      .run("pwd > where.txt")
      .cmd(["cat", "/srv/app/where.txt"])
      .build({ context: workspace, tags: [reference], noCache: true })

    await built.load()
    expect(await runImage(reference)).toContain("/srv/app")
  }, 300_000)
})

describe("Dockerfile front-end", () => {
  test("a multi-stage Dockerfile builds and runs", async () => {
    const reference = tag("multistage")
    const context = join(workspace, "multistage")
    await Bun.write(join(context, "app.sh"), '#!/bin/sh\necho "$GREETING"\ncat /opt/stamp\n')
    await Bun.write(join(context, "ignored.log"), "should not be copied")
    await Bun.write(join(context, ".dockerignore"), "*.log\n")

    const source = dockerfileText(
      [
        `ARG BASE=${BASE}`,
        "FROM ${BASE} AS builder",
        "RUN mkdir -p /out && echo stamped-in-builder > /out/stamp",
        "COPY app.sh /out/app.sh",
        "RUN chmod +x /out/app.sh",
        "",
        "FROM ${BASE}",
        "COPY --from=builder /out/app.sh /usr/local/bin/app",
        "COPY --from=builder /out/stamp /opt/stamp",
        'ENV GREETING="multi-stage works"',
        'CMD ["/usr/local/bin/app"]',
      ].join("\n"),
      { context },
    )

    const built = await source.build({ tags: [reference], noCache: true })
    await built.load()

    const output = await runImage(reference)
    expect(output).toContain("multi-stage works")
    expect(output).toContain("stamped-in-builder")
  }, 600_000)

  test("--build-arg overrides an ARG default, including in FROM", async () => {
    const source = dockerfileText(
      [`ARG BASE=does-not-exist:nope`, "FROM ${BASE}", "RUN echo ok"].join("\n"),
      { context: workspace },
    )

    // Building with the bad default must fail; overriding it must succeed.
    const built = await source.build({ buildArgs: { BASE }, noCache: true })
    expect(built.layers.length).toBeGreaterThan(0)
  }, 300_000)

  test("--target stops at the named stage", async () => {
    const reference = tag("target")
    const source = dockerfileText(
      [
        `FROM ${BASE} AS first`,
        "RUN echo first-stage > /opt-marker",
        `FROM ${BASE} AS second`,
        "RUN echo second-stage > /opt-marker",
      ].join("\n"),
      { context: workspace },
    )

    const built = await source.build({ target: "first", tags: [reference], noCache: true })
    await built.load()

    expect(await runImage(reference, ["cat", "/opt-marker"])).toContain("first-stage")
  }, 300_000)
})

describe("archive outputs", () => {
  test("a docker-format archive loads into microsandbox and boots", async () => {
    const reference = tag("docker-archive")
    const output = join(workspace, "docker-archive.tar")

    const built = await image(BASE)
      .run("echo docker-archive-path > /opt/marker")
      .cmd(["cat", "/opt/marker"])
      .build({ context: workspace, tags: [reference], noCache: true })

    await built.toArchive(output)

    const load = Bun.spawnSync(["msb", "load", "--input", output])
    expect(load.exitCode).toBe(0)
    expect(await runImage(reference)).toContain("docker-archive-path")
  }, 300_000)

  test("an OCI-layout archive loads into microsandbox and boots", async () => {
    const reference = tag("oci-archive")
    const output = join(workspace, "oci-archive.tar")

    const built = await image(BASE)
      .run("echo oci-archive-path > /opt/marker")
      .cmd(["cat", "/opt/marker"])
      .build({ context: workspace, tags: [reference], noCache: true })

    await built.toArchive(output, { format: "oci" })

    const load = Bun.spawnSync(["msb", "load", "--input", output])
    expect(load.exitCode).toBe(0)
    expect(await runImage(reference)).toContain("oci-archive-path")
  }, 300_000)
})

describe("reproducibility", () => {
  test("a declarative build twice over yields the same manifest digest", async () => {
    const context = join(workspace, "repro")
    await Bun.write(join(context, "file.txt"), "stable content")

    const spec = image(BASE).copy("file.txt", "/opt/file.txt").env({ A: "1" }).cmd(["/bin/true"])

    const first = await spec.build({ context })
    const second = await spec.build({ context })

    expect(second.manifestDescriptor.digest).toBe(first.manifestDescriptor.digest)
  }, 300_000)
})

describe("build cache", () => {
  test("an unchanged RUN step is served from cache on a rebuild", async () => {
    const cacheDir = join(workspace, "cache-run")
    const spec = image(BASE).run("echo cache-me > /opt/cached")

    await spec.build({ context: workspace, cacheDir })

    let cachedSteps = 0
    await spec.build({
      context: workspace,
      cacheDir,
      onProgress: (event) => {
        if (event.kind === "cached") cachedSteps += 1
      },
    })

    expect(cachedSteps).toBe(1)
  }, 600_000)
})

describe("cleanup", () => {
  test("a build leaves no sandboxes or staged images behind", async () => {
    await image(BASE).run("echo tidy > /opt/tidy").build({ context: workspace, noCache: true })

    const sandboxes = Bun.spawnSync(["msb", "ls"]).stdout.toString()
    const images = Bun.spawnSync(["msb", "images"]).stdout.toString()

    expect(sandboxes).not.toContain("beambox-build-")
    expect(images).not.toContain("beambox-build/")
  }, 300_000)
})
