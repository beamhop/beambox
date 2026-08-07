# beambox

Build OCI images for [microsandbox](https://microsandbox.dev) without Docker — a fluent
TypeScript API, a Dockerfile front-end, and the `beam` CLI.

```bash
bun add beambox
```

## The CLI

```bash
beam build -t my-app:local .              # build ./Dockerfile, load into microsandbox
msb run my-app:local

beam build -t my-app:local -o app.tar .   # write a docker-save archive
beam build -t ghcr.io/me/app:v1 --push .  # push to a registry
beam build --target builder .             # stop at a named stage
beam build --build-arg VERSION=1.2.3 .    # set a build argument
```

With no output option, `beam build` loads the image into the local microsandbox cache, so
it is immediately runnable with `msb run`. Run `beam help` for the full list.

## The TypeScript API

`ImageSpec` is immutable: every method returns a new spec, so specs can be shared and
branched without a later call reaching back and changing an earlier result.

```ts
import { image } from "beambox"

const base = image("node:22-slim").workdir("/app").env({ NODE_ENV: "production" })

// `base` is unchanged by either of these.
const api = base.copy("./api/dist", "/app").cmd(["node", "index.js"])
const worker = base.copy("./worker/dist", "/app").cmd(["node", "worker.js"])

const built = await api.build({ tags: ["api:local"] })
await built.load()
```

### Multi-stage builds

```ts
import { image } from "beambox"

const built = await image("node:22", { as: "builder" })
  .workdir("/src")
  .copy(["package.json", "package-lock.json"], "./")
  .run("npm ci", { mounts: [{ type: "cache", target: "/root/.npm", id: "npm" }] })
  .copy(".", ".")
  .run("npm run build")
  .stage("node:22-slim")
  .copy("/src/dist", "/app", { from: "builder" })
  .workdir("/app")
  .expose(3000)
  .cmd(["node", "index.js"])
  .build({ tags: ["app:local"] })

await built.load()
```

The `cache` mount becomes a microsandbox named volume, so the npm cache survives between
builds — and because it is its own filesystem, nothing in it ends up in the image.

### From a Dockerfile

```ts
import { dockerfile } from "beambox"

const source = await dockerfile("./Dockerfile", { context: "." })
const built = await source.build({
  tags: ["app:local"],
  buildArgs: { VERSION: "1.2.3" },
  onProgress: (event) => {
    if (event.kind === "step") console.log(event.instruction)
  },
})

await built.load()
```

`dockerfileText` does the same with a string, which is handy in tests.

### Outputs

```ts
const built = await image("alpine:3.20").cmd(["/bin/sh"]).build({ tags: ["demo:local"] })

await built.load()                                     // microsandbox cache
await built.toArchive("demo.tar")                      // docker save format
await built.toArchive("demo.oci.tar", { format: "oci" }) // OCI Image Layout
await built.toLayoutDirectory("./out/oci")             // unpacked, for skopeo/crane
await built.push("ghcr.io/me/demo:v1")                 // any OCI registry
```

A `BuiltImage` is also a plain `ImageArtifact`, so `built.config`, `built.manifest`, and
`built.layers` are all available to inspect.

### Private registries

```ts
const built = await image("registry.corp.io/team/base:v2")
  .cmd(["/app/server"])
  .build({
    registry: {
      auth: { kind: "basic", username: "deploy", password: process.env.REGISTRY_TOKEN ?? "" },
    },
  })
```

Credentials already in `~/.docker/config.json` are picked up automatically. Pass
`{ insecure: true }` for a plain-HTTP local registry.

### Declarative builds need nothing installed

A spec with no `.run()` never boots a VM and never loads the microsandbox SDK:

```ts
// Works on any machine, with no container runtime present at all.
const built = await image("gcr.io/distroless/static")
  .copy("./server", "/server")
  .cmd(["/server"])
  .build({ platform: { os: "linux", architecture: "amd64" } })

await built.toArchive("server.tar")
```

Because nothing is executed, this can target any platform — unlike `RUN`, which is limited
to the host architecture.

## Errors

Every failure is typed and explains itself: `DockerfileParseError` (with line and column),
`UnsupportedInstructionError`, `RunFailedError` (exit code plus output), `NoExecutorError`,
`PlatformMismatchError`, `CopySourceError`, `UnknownStageError`, `RegistryAuthError`.

```ts
import { RunFailedError } from "beambox"

try {
  await image("alpine").run("exit 42").build()
} catch (error) {
  if (error instanceof RunFailedError) console.error(error.exitCode) // 42
}
```

See the [root README](../../README.md) for how `RUN` works and the known limits.
