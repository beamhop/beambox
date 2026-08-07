# beambox

Build OCI images for [microsandbox](https://microsandbox.dev) without Docker.

**[Documentation →](https://beamhop.github.io/beambox/)**

microsandbox runs standard OCI images as microVM root filesystems, but it has no image
builder. Its own documentation tells you to reach for Docker:

```bash
docker build -t my-image:latest .
docker save my-image:latest | msb load
```

So the one tool microsandbox exists to replace is still a hard prerequisite for any custom
image. beambox closes that gap. It pulls base images, executes `RUN` steps, assembles
layers, and hands the result to microsandbox — all in TypeScript, with no daemon, no root,
and no Docker.

```bash
bun add -g @beamhop/beambox   # or: npm i -g @beamhop/beambox
```

The `-g` is what puts the `beambox` command on your PATH. To use the TypeScript API
instead, install it as a project dependency without `-g`. To run it once without
installing anything:

```bash
bunx @beamhop/beambox build -t my-app:local .   # or: npx @beamhop/beambox build …
```

Runs on Node 20+ and on Bun. `RUN` steps additionally need the
[microsandbox](https://microsandbox.dev) runtime; declarative builds need nothing at all.

## Quick start

```bash
beambox build -t my-app:local .   # build a Dockerfile and load it into microsandbox
msb run my-app:local              # run it
```

Or from TypeScript:

```ts
import { image } from "@beamhop/beambox"

const built = await image("alpine:3.20")
  .run("apk add --no-cache curl")
  .copy("./dist", "/app")
  .env({ NODE_ENV: "production" })
  .workdir("/app")
  .cmd(["/app/server"])
  .build({ tags: ["my-app:local"] })

await built.load()                      // straight into the microsandbox cache
await built.toArchive("my-app.tar")     // or a docker-save archive
await built.push("ghcr.io/me/my-app:v1") // or any OCI registry
```

## How `RUN` works without Docker

microsandbox becomes its own build engine. For each stage beambox loads the
work-in-progress image into microsandbox's cache, boots it as a microVM, and executes the
step inside. The layer is derived by indexing the guest root filesystem before and after
the step and diffing the two — deletions become OCI `.wh.` whiteouts, so `rm` in a `RUN`
behaves exactly as it does under Docker.

A statically linked busybox is bind-mounted in from the host, pulled through beambox's own
registry client. The guest therefore needs no shell, `tar`, or `find` of its own, and
`RUN` works even on `scratch` and distroless bases.

A build with **no** `RUN` steps never boots a VM and never loads the microsandbox SDK, so
purely declarative builds work anywhere, with nothing installed.

## Packages

| Package | What it does |
| --- | --- |
| [`@beamhop/beambox`](packages/beambox) | The package you install: fluent API, Dockerfile front-end, and the `beambox` CLI |
| [`@beamhop/oci`](packages/oci) | OCI primitives — digests, deterministic layer tars, manifests, archive formats |
| [`@beamhop/registry`](packages/registry) | OCI Distribution v2 client — pull and push, no daemon |
| [`@beamhop/builder`](packages/builder) | The build engine: stages, layer assembly, caching, executor interface |
| [`@beamhop/dockerfile`](packages/dockerfile) | Dockerfile lexer and parser, lowered onto the build engine |
| [`@beamhop/microsandbox`](packages/microsandbox) | The microVM `RUN` executor and the `msb` handoff |

`@beamhop/builder` never imports microsandbox. The runtime dependency exists only where a
`RUN` step actually needs it.

## Dockerfile support

Supported: `FROM` (including `AS`, `--platform`, and multi-stage), `RUN` (shell and exec
form, `--mount=type=cache|bind|tmpfs`), `COPY` and `ADD` (including `--from`, `--chown`,
`--chmod`, and tar auto-extraction), `ENV`, `ARG`, `LABEL`, `WORKDIR`, `USER`, `CMD`,
`ENTRYPOINT`, `EXPOSE`, `VOLUME`, `STOPSIGNAL`, `HEALTHCHECK`, and `SHELL` — plus
heredocs, line continuations, the `escape` directive, variable expansion, and
`.dockerignore`.

Refused **by name and line number**, never silently skipped: `ONBUILD`, `MAINTAINER`,
`ADD` from a URL, `RUN --mount=type=secret|ssh`, `RUN --network`, `RUN --security`, and
non-default BuildKit frontends. An instruction that quietly does nothing produces an image
that looks right and behaves wrong, which is worse than a build that stops and explains.

## Known limits

- **`RUN` only builds for the host architecture.** microsandbox boots native microVMs with
  no emulation layer, so `--platform linux/amd64` with a `RUN` step cannot work on an
  arm64 host. beambox fails with `PlatformMismatchError` rather than mislabelling the
  image. Declarative builds can target any platform, because nothing is executed.
- **`RUN` needs the microsandbox runtime.** Declarative builds do not.
- **Layer diffs use size, mtime, and mode.** Content rewritten in place with all three
  preserved would not be detected.
- **`--chown` takes numeric IDs.** Names would require reading the image's `/etc/passwd`.

## Development

```bash
bun install
bun test          # unit and integration — no network, no VMs
bun run test:node # the built output executed by Node — no network, no VMs
bun run test:e2e  # real builds against a real microsandbox runtime (needs `msb`)
bun run typecheck
bun run lint
bun run site:dev  # the documentation site — see site/README.md
```

The registry tests run a real, spec-conformant OCI registry in process rather than a mock,
and the e2e suite proves every claim by booting the finished image and reading what it
prints. `test:node` exists because the rest of the suite runs under Bun: it executes the
built bundles with Node and fails if any of them still reach for a `Bun.*` global.

## Releasing

```bash
npm login
scripts/publish.sh          # publishes all six packages, dependencies first
scripts/publish.sh --dry-run
```

`bun publish` is required rather than `npm publish`: it rewrites the `workspace:*` ranges
to the version being published, which npm would otherwise ship verbatim.

If the account has two-factor authentication required for writes, use an npm **automation**
token rather than a read-only or session token — publishing otherwise blocks on a one-time
password prompt.

## Licence

MIT
