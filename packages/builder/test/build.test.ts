import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { BlobStore } from "@beamhop/oci"
import { build } from "../src/build.ts"
import { NoExecutorError, PlatformMismatchError, UnknownStageError } from "../src/errors.ts"
import type { BuildPlan } from "../src/spec.ts"
import { StageFilesystem } from "../src/stage-fs.ts"
import { configOf, RecordingExecutor, withWorkspace } from "./helpers.ts"

let store: BlobStore
let context: string
let cleanup: () => Promise<void>

const platform = { architecture: "arm64", os: "linux" }

beforeEach(async () => {
  const workspace = await withWorkspace()
  store = workspace.store
  context = workspace.context
  cleanup = workspace.cleanup
})
afterEach(() => cleanup())

const plan = (ops: BuildPlan["stages"][number]["ops"]): BuildPlan => ({
  stages: [{ base: { kind: "scratch" }, ops }],
})

describe("declarative builds", () => {
  test("build with no RUN steps needs no executor at all", async () => {
    await Bun.write(join(context, "app", "index.js"), "console.log('hi')")

    const image = await build(plan([{ kind: "copy", sources: ["app"], destination: "/srv/" }]), {
      store,
      context,
      platform,
    })

    const filesystem = await StageFilesystem.open(image.layers)
    expect(filesystem.paths()).toContain("srv/app/index.js")
  })

  test("applies config instructions to the image config", async () => {
    const image = await build(
      plan([
        { kind: "env", values: { NODE_ENV: "production", PORT: "3000" } },
        { kind: "workdir", path: "/app" },
        { kind: "user", user: "1000:1000" },
        { kind: "label", values: { "org.opencontainers.image.title": "demo" } },
        { kind: "expose", ports: ["8080", "9090/udp"] },
        { kind: "volume", paths: ["/data"] },
        { kind: "stopsignal", signal: "SIGTERM" },
        { kind: "cmd", command: { form: "exec", argv: ["node", "index.js"] } },
      ]),
      { store, context, platform },
    )

    const config = configOf(image)
    expect(config.Env).toEqual(["NODE_ENV=production", "PORT=3000"])
    expect(config.WorkingDir).toBe("/app")
    expect(config.User).toBe("1000:1000")
    expect(config.Labels).toEqual({ "org.opencontainers.image.title": "demo" })
    expect(config.ExposedPorts).toEqual({ "8080/tcp": {}, "9090/udp": {} })
    expect(config.Volumes).toEqual({ "/data": {} })
    expect(config.StopSignal).toBe("SIGTERM")
    expect(config.Cmd).toEqual(["node", "index.js"])
  })

  test("relative WORKDIR stacks on the previous one", async () => {
    const image = await build(
      plan([
        { kind: "workdir", path: "/app" },
        { kind: "workdir", path: "src" },
      ]),
      { store, context, platform },
    )
    expect(configOf(image).WorkingDir).toBe("/app/src")
  })

  test("shell-form CMD is wrapped in the configured shell", async () => {
    const image = await build(
      plan([
        { kind: "shell", shell: ["/bin/bash", "-lc"] },
        { kind: "cmd", command: { form: "shell", command: "node index.js" } },
      ]),
      { store, context, platform },
    )
    expect(configOf(image).Cmd).toEqual(["/bin/bash", "-lc", "node index.js"])
  })

  test("ENTRYPOINT resets CMD, as Docker does", async () => {
    const image = await build(
      plan([
        { kind: "cmd", command: { form: "exec", argv: ["old"] } },
        { kind: "entrypoint", command: { form: "exec", argv: ["/entry"] } },
      ]),
      { store, context, platform },
    )
    expect(configOf(image).Entrypoint).toEqual(["/entry"])
    expect(configOf(image).Cmd).toBeNull()
  })

  test("expands variables from ENV and ARG, with ENV winning", async () => {
    await Bun.write(join(context, "v2", "file.txt"), "content")

    const image = await build(
      {
        stages: [
          {
            base: { kind: "scratch" },
            ops: [
              { kind: "arg", name: "VERSION", defaultValue: "v1" },
              { kind: "env", values: { VERSION: "v2" } },
              { kind: "copy", sources: ["${VERSION}"], destination: "/out/" },
              { kind: "label", values: { version: "$VERSION" } },
            ],
          },
        ],
      },
      { store, context, platform },
    )

    expect(configOf(image).Labels).toEqual({ version: "v2" })
    const filesystem = await StageFilesystem.open(image.layers)
    expect(filesystem.paths()).toContain("out/v2/file.txt")
  })

  test("build args override ARG defaults", async () => {
    const image = await build(
      plan([
        { kind: "arg", name: "TAG", defaultValue: "dev" },
        { kind: "label", values: { tag: "${TAG}" } },
      ]),
      { store, context, platform, buildArgs: { TAG: "release" } },
    )
    expect(configOf(image).Labels).toEqual({ tag: "release" })
  })

  test("records history so the image explains how it was made", async () => {
    const image = await build(
      plan([
        { kind: "env", values: { A: "1" } },
        { kind: "copy", sources: [".keep"], destination: "/keep" },
      ]),
      { store, context, platform },
    )

    const history = image.config.history ?? []
    expect(history.map((entry) => entry.created_by)).toEqual(["ENV A=1", "COPY .keep /keep"])
    expect(history[0]?.empty_layer).toBe(true)
    expect(history[1]?.empty_layer).toBeUndefined()
  })
})

describe("COPY semantics", () => {
  test("copying a directory contributes its contents, not the directory itself", async () => {
    await Bun.write(join(context, "dist", "a.js"), "a")
    await Bun.write(join(context, "dist", "nested", "b.js"), "b")

    const image = await build(plan([{ kind: "copy", sources: ["dist"], destination: "/app" }]), {
      store,
      context,
      platform,
    })

    const paths = (await StageFilesystem.open(image.layers)).paths()
    expect(paths).toContain("app/a.js")
    expect(paths).toContain("app/nested/b.js")
    expect(paths).not.toContain("app/dist/a.js")
  })

  test("a destination ending in / places the file inside it", async () => {
    await Bun.write(join(context, "server.js"), "x")

    const image = await build(
      plan([{ kind: "copy", sources: ["server.js"], destination: "/app/" }]),
      {
        store,
        context,
        platform,
      },
    )

    expect((await StageFilesystem.open(image.layers)).paths()).toContain("app/server.js")
  })

  test("a destination without a slash renames a single file", async () => {
    await Bun.write(join(context, "server.js"), "x")

    const image = await build(
      plan([{ kind: "copy", sources: ["server.js"], destination: "/app/main.js" }]),
      { store, context, platform },
    )

    expect((await StageFilesystem.open(image.layers)).paths()).toContain("app/main.js")
  })

  test("honours .dockerignore, including re-inclusion with !", async () => {
    await Bun.write(join(context, ".dockerignore"), "node_modules\n*.log\n!keep.log\n")
    await Bun.write(join(context, "src", "index.js"), "x")
    await Bun.write(join(context, "node_modules", "dep", "index.js"), "y")
    await Bun.write(join(context, "debug.log"), "z")
    await Bun.write(join(context, "keep.log"), "w")

    const image = await build(plan([{ kind: "copy", sources: ["."], destination: "/app" }]), {
      store,
      context,
      platform,
    })

    const paths = (await StageFilesystem.open(image.layers)).paths()
    expect(paths).toContain("app/src/index.js")
    expect(paths).toContain("app/keep.log")
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false)
    expect(paths).not.toContain("app/debug.log")
  })

  test("applies --chmod and numeric --chown", async () => {
    await Bun.write(join(context, "run.sh"), "#!/bin/sh\n")

    const image = await build(
      plan([
        {
          kind: "copy",
          sources: ["run.sh"],
          destination: "/run.sh",
          chmod: "755",
          chown: "1000:1000",
        },
      ]),
      { store, context, platform },
    )

    const entries = await StageFilesystem.open(image.layers)
    const copied = await entries.resolve(["/run.sh"], "/out")
    expect(copied[0]?.kind).toBe("file")
    expect(copied[0] && "mode" in copied[0] ? copied[0].mode : 0).toBe(0o755)
  })

  test("rejects a source outside the build context", async () => {
    await expect(
      build(plan([{ kind: "copy", sources: ["../escape.txt"], destination: "/x" }]), {
        store,
        context,
        platform,
      }),
    ).rejects.toThrow(/outside the build context/)
  })

  test("rejects a source that matches nothing", async () => {
    await expect(
      build(plan([{ kind: "copy", sources: ["missing.txt"], destination: "/x" }]), {
        store,
        context,
        platform,
      }),
    ).rejects.toThrow(/does not exist/)
  })
})

describe("multi-stage builds", () => {
  test("COPY --from reads the earlier stage's filesystem", async () => {
    await Bun.write(join(context, "src", "index.ts"), "export const x = 1")

    const image = await build(
      {
        stages: [
          {
            name: "builder",
            base: { kind: "scratch" },
            ops: [{ kind: "copy", sources: ["src"], destination: "/build/out" }],
          },
          {
            base: { kind: "scratch" },
            ops: [
              { kind: "copy", from: "builder", sources: ["/build/out"], destination: "/app" },
              { kind: "cmd", command: { form: "exec", argv: ["/app/index.ts"] } },
            ],
          },
        ],
      },
      { store, context, platform },
    )

    const paths = (await StageFilesystem.open(image.layers)).paths()
    expect(paths).toContain("app/index.ts")
    // The final image must not carry the builder stage's own layout.
    expect(paths).not.toContain("build/out/index.ts")
  })

  test("--target stops at the named stage", async () => {
    await Bun.write(join(context, "a.txt"), "a")

    const image = await build(
      {
        target: "first",
        stages: [
          {
            name: "first",
            base: { kind: "scratch" },
            ops: [{ kind: "copy", sources: ["a.txt"], destination: "/a.txt" }],
          },
          {
            base: { kind: "scratch" },
            ops: [{ kind: "label", values: { should: "not-run" } }],
          },
        ],
      },
      { store, context, platform },
    )

    expect(configOf(image).Labels).toBeUndefined()
    expect((await StageFilesystem.open(image.layers)).paths()).toContain("a.txt")
  })

  test("a stage can start FROM an earlier stage", async () => {
    await Bun.write(join(context, "a.txt"), "a")

    const image = await build(
      {
        stages: [
          {
            name: "base",
            base: { kind: "scratch" },
            ops: [{ kind: "copy", sources: ["a.txt"], destination: "/a.txt" }],
          },
          {
            base: { kind: "stage", stage: "base" },
            ops: [{ kind: "env", values: { EXTENDED: "yes" } }],
          },
        ],
      },
      { store, context, platform },
    )

    expect(configOf(image).Env).toEqual(["EXTENDED=yes"])
    expect((await StageFilesystem.open(image.layers)).paths()).toContain("a.txt")
  })

  test("reports an unknown stage rather than silently skipping the copy", async () => {
    await expect(
      build(
        {
          stages: [
            {
              base: { kind: "scratch" },
              ops: [{ kind: "copy", from: "nope", sources: ["/x"], destination: "/y" }],
            },
          ],
        },
        { store, context, platform },
      ),
    ).rejects.toThrow(UnknownStageError)
  })
})

describe("RUN orchestration", () => {
  test("refuses a RUN step when no executor is configured", async () => {
    await expect(
      build(plan([{ kind: "run", command: { form: "shell", command: "echo hi" } }]), {
        store,
        context,
        platform,
      }),
    ).rejects.toThrow(NoExecutorError)
  })

  test("refuses to execute for a platform the executor cannot run", async () => {
    const executor = new RecordingExecutor({ unsupported: "linux/arm64" })
    await expect(
      build(plan([{ kind: "run", command: { form: "shell", command: "echo hi" } }]), {
        store,
        context,
        platform: { architecture: "amd64", os: "linux" },
        executor,
      }),
    ).rejects.toThrow(PlatformMismatchError)
  })

  test("wraps a shell-form RUN in the image's shell and passes the current env and workdir", async () => {
    const executor = new RecordingExecutor()
    await build(
      plan([
        { kind: "env", values: { FOO: "bar" } },
        { kind: "workdir", path: "/app" },
        { kind: "run", command: { form: "shell", command: "make build" } },
      ]),
      { store, context, platform, executor, cache: false },
    )

    const step = executor.steps[0]
    expect(step?.argv).toEqual(["/bin/sh", "-c", "make build"])
    expect(step?.env).toMatchObject({ FOO: "bar" })
    expect(step?.workdir).toBe("/app")
  })

  test("exec-form RUN bypasses the shell entirely", async () => {
    const executor = new RecordingExecutor()
    await build(plan([{ kind: "run", command: { form: "exec", argv: ["/bin/true", "--flag"] } }]), {
      store,
      context,
      platform,
      executor,
      cache: false,
    })
    expect(executor.steps[0]?.argv).toEqual(["/bin/true", "--flag"])
  })

  test("opens one sandbox per stage and closes it when the stage ends", async () => {
    const executor = new RecordingExecutor()
    await build(
      plan([
        { kind: "run", command: { form: "shell", command: "step one" } },
        { kind: "run", command: { form: "shell", command: "step two" } },
        { kind: "run", command: { form: "shell", command: "step three" } },
      ]),
      { store, context, platform, executor, cache: false },
    )

    expect(executor.sessions).toHaveLength(1)
    expect(executor.openSessions).toBe(0)
    expect(executor.steps).toHaveLength(3)
  })

  test("routes a COPY through the sandbox when a later RUN must see the files", async () => {
    await Bun.write(join(context, "app.js"), "x")
    const executor = new RecordingExecutor()

    await build(
      plan([
        { kind: "run", command: { form: "shell", command: "prepare" } },
        { kind: "copy", sources: ["app.js"], destination: "/app.js" },
        { kind: "run", command: { form: "shell", command: "use /app.js" } },
      ]),
      { store, context, platform, executor, cache: false },
    )

    expect(executor.steps.map((step) => step.kind)).toEqual(["run", "materialize", "run"])
  })

  test("closes the sandbox and builds on the host once no RUN steps remain", async () => {
    await Bun.write(join(context, "app.js"), "x")
    const executor = new RecordingExecutor()

    await build(
      plan([
        { kind: "run", command: { form: "shell", command: "prepare" } },
        { kind: "copy", sources: ["app.js"], destination: "/app.js" },
      ]),
      { store, context, platform, executor, cache: false },
    )

    // The trailing COPY never reaches the executor — it is cheaper to layer on the host.
    expect(executor.steps.map((step) => step.kind)).toEqual(["run"])
    expect(executor.openSessions).toBe(0)
  })

  test("a RUN step still contributes its layer to the final image", async () => {
    const executor = new RecordingExecutor()
    const image = await build(
      plan([{ kind: "run", command: { form: "shell", command: "make" } }]),
      { store, context, platform, executor, cache: false },
    )

    expect(image.layers).toHaveLength(1)
    expect(image.config.rootfs.diff_ids).toEqual(image.layers.map((layer) => layer.diffId))
  })
})
