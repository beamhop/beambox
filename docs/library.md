# Library guide

Build images from TypeScript, step by step. Use this when the image is *generated* — one
per tenant, per test, per branch — rather than checked in as a Dockerfile.

## 1. Install

A normal project dependency; no global install, no `-g`:

```bash
bun add @beamhop/beambox   # or: npm i @beamhop/beambox
```

Node 20+ or Bun. Everything below is one import away:

```ts
import { image, dockerfile, dockerfileText } from "@beamhop/beambox"
```

## 2. Your first build

`image(base)` starts a spec, the fluent methods describe it, and `build()` produces it:

```ts
import { image } from "@beamhop/beambox"

const built = await image("alpine:3.20")
  .run("apk add --no-cache curl")
  .cmd(["/bin/sh"])
  .build({ tags: ["demo:local"] })

await built.load()   // into the microsandbox cache → msb run demo:local
```

`build()` resolves to a `BuiltImage`. Nothing is written anywhere until you ask for an
output in step 6.

## 3. Specs are immutable

Every method returns a **new** spec. A base can be shared and branched without a later
call reaching back and changing an earlier result:

```ts
const base = image("node:22-slim").workdir("/app").env({ NODE_ENV: "production" })

// `base` is unchanged by either of these.
const api = base.copy("./api/dist", "/app").cmd(["node", "index.js"])
const worker = base.copy("./worker/dist", "/app").cmd(["node", "worker.js"])

const [apiImage, workerImage] = await Promise.all([
  api.build({ tags: ["api:local"] }),
  worker.build({ tags: ["worker:local"] }),
])
```

That is the property the whole API is designed around — it is what makes generating a
family of images from one description safe.

## 4. The methods

| Method | Dockerfile equivalent |
| --- | --- |
| `image(base, { as, platform })` | `FROM base AS name` — `"scratch"` starts empty |
| `.stage(base, { as })` | A new `FROM`, beginning the next stage |
| `.run(command, { mounts, env })` | `RUN` — a string is shell form, an array is exec form |
| `.copy(sources, dest, { from, chown, chmod })` | `COPY` |
| `.add(sources, dest, { from, chown, chmod })` | `ADD`, including tar auto-extraction |
| `.env(values)` / `.arg(name, default)` / `.label(values)` | `ENV` / `ARG` / `LABEL` |
| `.workdir(path)` / `.user(user)` | `WORKDIR` / `USER` |
| `.cmd(command)` / `.entrypoint(command)` | `CMD` / `ENTRYPOINT` — `null` clears it |
| `.expose(...ports)` / `.volume(...paths)` / `.shell(argv)` / `.healthcheck(...)` | the rest |

`.copy` takes one path or an array, and globs are allowed. `chown` takes numeric IDs
(`"1000:1000"`) — names would require reading the image's `/etc/passwd`.

## 5. Multi-stage, with a cache mount

```ts
const built = await image("node:22", { as: "builder" })
  .workdir("/src")
  .copy(["package.json", "package-lock.json"], "./")
  .run("npm ci", { mounts: [{ type: "cache", target: "/root/.npm", id: "npm" }] })
  .copy(".", ".")
  .run("npm run build")
  .stage("node:22-slim")                       // second stage starts here
  .copy("/src/dist", "/app", { from: "builder" })
  .workdir("/app")
  .expose(3000)
  .cmd(["node", "index.js"])
  .build({ tags: ["app:local"] })
```

Three mount types: `cache` (a persistent microsandbox named volume, shared across builds),
`bind` (a directory from the context or an earlier stage), and `tmpfs`. A cache mount is
its own filesystem, so nothing in it ends up in the image.

## 6. Getting the image out

```ts
await built.load()                                       // microsandbox cache
await built.toArchive("app.tar")                         // docker save format
await built.toArchive("app.oci.tar", { format: "oci" })  // OCI Image Layout
await built.toLayoutDirectory("./out/oci")               // unpacked, for skopeo/oras/crane
const digest = await built.push("ghcr.io/me/app:v1")     // any OCI registry
```

Each takes an optional `{ tags }` to override the tags given to `build()`. A `BuiltImage`
is also a plain `ImageArtifact`, so `built.config`, `built.manifest`, and `built.layers`
are there to inspect — useful in tests that assert on the result rather than run it.

## 7. Build settings

```ts
await spec.build({
  context: "./app",                    // what COPY and ADD read from; default: cwd
  tags: ["app:local"],
  platform: { os: "linux", architecture: "arm64" },
  buildArgs: { VERSION: "1.2.3" },
  cacheDir: "./.cache/beambox",        // default: ~/.cache/beambox
  noCache: true,                       // ignore cached RUN results
  registry: { insecure: true },
  onProgress: (event) => { /* see below */ },
})
```

`onProgress` receives a discriminated `BuildEvent` — `stage`, `step`, `cached`, `pull`,
`output`, and `warning` — so a custom reporter is a `switch`:

```ts
onProgress: (event) => {
  if (event.kind === "step") console.log(`[${event.index + 1}/${event.total}] ${event.instruction}`)
  if (event.kind === "output") process.stderr.write(event.text)
}
```

## 8. Building an existing Dockerfile from code

Same engine, same events, same result type:

```ts
import { dockerfile, dockerfileText } from "@beamhop/beambox"

const source = await dockerfile("./Dockerfile", { context: "." })
const built = await source.build({ tags: ["app:local"], target: "builder" })

// `source.plan` is the parsed plan, if you want to inspect or transform it first.
```

`dockerfileText(text, { context })` takes a string instead of a path — the right choice in
tests, where the Dockerfile is part of the test case.

## 9. Private registries

Credentials in `~/.docker/config.json` are picked up automatically. To be explicit:

```ts
const built = await image("registry.corp.io/team/base:v2")
  .cmd(["/app/server"])
  .build({
    registry: {
      auth: { kind: "basic", username: "deploy", password: process.env.REGISTRY_TOKEN ?? "" },
      insecure: false,
    },
  })
```

## 10. Declarative builds need nothing installed

A spec with no `.run()` never boots a VM and never loads the microsandbox SDK, so it runs
on a machine with no container runtime at all — and, because nothing is executed, it can
target any platform:

```ts
const built = await image("gcr.io/distroless/static")
  .copy("./server", "/server")
  .cmd(["/server"])
  .build({ platform: { os: "linux", architecture: "amd64" } })

await built.toArchive("server.tar")
```

Add a `.run()` and the same build becomes host-architecture only — beambox raises
`PlatformMismatchError` rather than mislabelling the image.

## 11. Handling failures

Every failure is a class you can catch, and they all extend `BeamboxError`:

```ts
import { RunFailedError, UnsupportedInstructionError } from "@beamhop/beambox"

try {
  await image("alpine:3.20").run("exit 42").build()
} catch (error) {
  if (error instanceof RunFailedError) {
    console.error(error.exitCode)   // 42
    console.error(error.output)     // what the step printed
  }
  if (error instanceof UnsupportedInstructionError) throw error  // rewrite, do not retry
}
```

Also exported: `DockerfileParseError` (line and column), `NoExecutorError`,
`PlatformMismatchError`, `CopySourceError`, `UnknownStageError`, `RegistryAuthError`,
`RegistryRequestError`, `ForeignLayerError`, `PlatformNotFoundError`.

## 12. Testing a build

Declarative builds need no runtime, so they run in an ordinary unit test:

```ts
import { expect, test } from "bun:test"
import { image } from "@beamhop/beambox"

test("the server image exposes 3000 and starts the binary", async () => {
  const built = await image("gcr.io/distroless/static")
    .copy("./fixtures/server", "/server")
    .expose(3000)
    .cmd(["/server"])
    .build({ platform: { os: "linux", architecture: "amd64" } })

  expect(built.config.config?.Cmd).toEqual(["/server"])
  expect(Object.keys(built.config.config?.ExposedPorts ?? {})).toContain("3000/tcp")
})
```

For a `RUN` step, pass your own `executor` in `build({ executor })` — the `Executor`
interface is exported, and it is how the microsandbox executor is plugged in too.

## Next

- The same thing from the shell — the [CLI guide](./cli.md)
- Full API reference — [`@beamhop/beambox`](../packages/beambox/README.md)
