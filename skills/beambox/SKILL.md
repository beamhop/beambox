---
name: beambox
description: Build OCI images for microsandbox (msb) without Docker, using the beambox CLI or its TypeScript API. Use when asked to build, tag, load, archive, or push a container image for a microVM, when a Dockerfile needs building but Docker is unavailable, or when an image must be ready for `msb run`.
---

# beambox — the image builder for microsandbox

microsandbox (`msb`) runs OCI images as microVM root filesystems but ships no image
builder; its own docs tell you to use `docker build … | msb load`. beambox replaces that
step: it pulls base images, executes `RUN` in a microVM, assembles layers, and hands the
result to `msb` — no daemon, no root, no Docker.

Reach for this skill whenever the goal ends in a runnable `msb run <tag>`.

## 1. Check what is installed

```bash
beambox version   # the builder
msb --version     # the runtime; only RUN steps and --load need it
```

If `beambox` is missing, either install it or run it without installing:

```bash
bun add -g @beamhop/beambox              # or: npm i -g @beamhop/beambox
bunx @beamhop/beambox build -t app:local .   # or: npx @beamhop/beambox …
```

Needs Node 20+ or Bun. A build with **no** `RUN` step never boots a VM and never loads the
microsandbox SDK, so declarative builds work on a machine with nothing else installed —
do not tell the user to install `msb` unless the build actually runs a command or loads.

## 2. Build from a Dockerfile (the default path)

```bash
beambox build -t my-app:local .   # builds ./Dockerfile, loads into the msb image cache
msb run my-app:local
```

With no output flag beambox loads the image, so it is immediately runnable. Other
destinations:

```bash
beambox build -t my-app:local -o app.tar .           # docker-save archive
beambox build -t my-app:local -o app.oci.tar --format oci .
beambox build -t my-app:local --layout ./out/oci .   # unpacked OCI layout
beambox build -t ghcr.io/me/app:v1 --push .          # any OCI Distribution v2 registry
```

Useful flags: `-f <path>` (Dockerfile elsewhere), `--target <stage>`, `--build-arg K=V`
(repeatable; bare `--build-arg K` forwards from the environment), `--platform linux/arm64`,
`--no-cache`, `--insecure` (plain-HTTP registry), `-q`. `--push` requires a `--tag` naming
where to push. `beambox help` prints the full list.

## 3. Build from TypeScript

Prefer this when the image is generated rather than checked in. `ImageSpec` is immutable —
every method returns a new spec, so a base spec can be branched safely.

```ts
import { image } from "@beamhop/beambox"

const built = await image("node:22", { as: "builder" })
  .workdir("/src")
  .copy(["package.json", "package-lock.json"], "./")
  .run("npm ci", { mounts: [{ type: "cache", target: "/root/.npm", id: "npm" }] })
  .copy(".", ".")
  .run("npm run build")
  .stage("node:22-slim")                              // second stage
  .copy("/src/dist", "/app", { from: "builder" })
  .workdir("/app")
  .expose(3000)
  .cmd(["node", "index.js"])
  .build({ tags: ["app:local"] })

await built.load()                                     // → msb run app:local
await built.toArchive("app.tar")                       // docker save format
await built.toArchive("app.oci.tar", { format: "oci" })
await built.toLayoutDirectory("./out/oci")             // for skopeo / oras / crane
await built.push("ghcr.io/me/app:v1")                  // returns the pushed digest
```

Other spec methods: `env`, `arg`, `label`, `user`, `entrypoint`, `add`, `volume`, `shell`,
`healthcheck`. A `cache` mount becomes a microsandbox named volume, so it survives between
builds and never lands in the image.

To drive an existing Dockerfile from code:

```ts
import { dockerfile } from "@beamhop/beambox"

const source = await dockerfile("./Dockerfile", { context: "." })
const built = await source.build({
  tags: ["app:local"],
  buildArgs: { VERSION: "1.2.3" },
  onProgress: (event) => {
    if (event.kind === "step") console.log(event.instruction)
  },
})
```

`dockerfileText(text, { context })` does the same with a string — the right choice in tests.

Private registries: credentials in `~/.docker/config.json` are picked up automatically;
otherwise pass `build({ registry: { auth: { kind: "basic", username, password } } })`, plus
`insecure: true` for a plain-HTTP local registry.

## 4. What beambox will not do

Supported: `FROM` (with `AS`, `--platform`, multi-stage), `RUN` (shell and exec form,
`--mount=type=cache|bind|tmpfs`), `COPY`/`ADD` (with `--from`, `--chown`, `--chmod`, tar
auto-extraction), `ENV`, `ARG`, `LABEL`, `WORKDIR`, `USER`, `CMD`, `ENTRYPOINT`, `EXPOSE`,
`VOLUME`, `STOPSIGNAL`, `HEALTHCHECK`, `SHELL`, heredocs, line continuations, the `escape`
directive, variable expansion, and `.dockerignore`.

Refused by name and line number — never silently skipped: `ONBUILD`, `MAINTAINER`, `ADD`
from a URL, `RUN --mount=type=secret|ssh`, `RUN --network`, `RUN --security`, and
non-default BuildKit frontends. If a build fails on one of these, rewrite the Dockerfile;
do not try to work around the refusal.

Known limits worth stating to the user before they hit them:

- `RUN` only builds for the **host** architecture. microsandbox boots native microVMs with
  no emulation, so `--platform linux/amd64` plus a `RUN` step on an arm64 host fails with
  `PlatformMismatchError`. Declarative builds can target any platform.
- Layer diffs use size, mtime, and mode — a file rewritten in place preserving all three is
  not detected.
- `--chown` takes numeric IDs, not names.

## 5. Reading failures

Every failure is a typed class you can catch (all extend `BeamboxError`):

| Error | What it means |
| --- | --- |
| `DockerfileParseError` | Syntax error; carries line and column |
| `UnsupportedInstructionError` | A refused instruction, by name and line |
| `RunFailedError` | A `RUN` step exited non-zero; carries exit code and output |
| `NoExecutorError` | A `RUN` step with no microsandbox runtime available — install `msb` |
| `PlatformMismatchError` | `RUN` requested for a non-host architecture |
| `CopySourceError` | A `COPY`/`ADD` source path matched nothing |
| `UnknownStageError` | `--target` or `--from` named a stage that does not exist |
| `RegistryAuthError`, `RegistryRequestError`, `ForeignLayerError`, `PlatformNotFoundError` | Registry-side problems |

## 6. Verify before reporting success

Build claims are cheap; run the image.

```bash
beambox build -t my-app:local . && msb run my-app:local
```

If `msb` is unavailable, inspect the artifact instead (`built.config`, `built.manifest`,
`built.layers` — a `BuiltImage` is a plain `ImageArtifact`) and say plainly that the image
was built but not executed.

Full documentation: <https://beamhop.github.io/beambox/>
