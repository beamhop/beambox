# CLI guide

Build a Dockerfile into a microsandbox-runnable image, step by step. Nothing here needs
Docker, a daemon, or root.

## 1. Install the CLI

The `-g` is what puts the `beambox` command on your PATH:

```bash
bun add -g @beamhop/beambox   # or: npm i -g @beamhop/beambox
beambox version
```

To try it once without installing anything, replace `beambox` with
`bunx @beamhop/beambox` (or `npx @beamhop/beambox`) in every command below.

You also want the [microsandbox](https://microsandbox.dev) runtime, which is what executes
`RUN` steps and what `msb run` comes from:

```bash
msb --version
```

If your Dockerfile has no `RUN` instruction, skip that: a declarative build never boots a
VM and never loads the microsandbox SDK.

## 2. Write a Dockerfile

Nothing beambox-specific — an ordinary Dockerfile in an ordinary build context:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

## 3. Build it

```bash
beambox build -t my-app:local .
```

The positional argument is the build context; `./Dockerfile` inside it is the default file.
Progress goes to **stderr**, so piping stdout stays clean.

```
  pulling docker.io/library/node:22-slim
  [1/6] WORKDIR /app
  [2/6] COPY package.json package-lock.json ./
  [3/6] RUN npm ci --omit=dev
        added 84 packages in 3s
  ...
✓ built 4 layers in 11.2s
  loaded my-app:local
```

With no output flag beambox loads the image into the local microsandbox cache — the
useful default, because it is the thing `msb` can immediately run.

## 4. Run it

```bash
msb run my-app:local
```

## 5. Send it somewhere else

Each output flag is independent, and they combine — one build, several destinations:

```bash
beambox build -t my-app:local -o app.tar .                    # docker save archive
beambox build -t my-app:local -o app.oci.tar --format oci .   # OCI Image Layout archive
beambox build -t my-app:local --layout ./out/oci .            # unpacked, for skopeo/crane
beambox build -t ghcr.io/me/my-app:v1 --push .                # any OCI Distribution v2 registry
beambox build -t my-app:local -o app.tar --load .             # archive *and* the msb cache
```

`msb load` and `docker load` both accept either archive format. `--push` needs a `--tag`
naming where to push, and pushes the **first** tag.

Registry credentials already in `~/.docker/config.json` are used automatically. For a
plain-HTTP local registry, add `--insecure`.

## 6. The flags you will actually reach for

| Flag | What it does |
| --- | --- |
| `-f, --file <path>` | A Dockerfile outside the context, or under another name |
| `-t, --tag <ref>` | Tag the result; repeatable |
| `--target <stage>` | Stop at a named stage — build the `builder` stage and no further |
| `--build-arg K=V` | Set an `ARG`; repeatable. Bare `--build-arg K` forwards `K` from the environment |
| `--platform linux/arm64` | Target platform. Declarative builds only — see the limit below |
| `--no-cache` | Ignore cached `RUN` results |
| `--insecure` | Plain HTTP for registries |
| `-q, --quiet` | Errors only |

`beambox help` prints the full list.

## 7. Multi-stage, and stopping early

```dockerfile
FROM node:22 AS builder
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci && npm run build

FROM node:22-slim
COPY --from=builder /src/dist /app
WORKDIR /app
CMD ["node", "index.js"]
```

```bash
beambox build -t app:local .                    # the final stage
beambox build --target builder -t build:local . # stop at the first
```

The `cache` mount becomes a microsandbox named volume: the npm cache survives between
builds, and because it is its own filesystem nothing in it lands in the image.

## 8. In CI

```yaml
- run: npx @beamhop/beambox build -t ghcr.io/me/app:${{ github.sha }} --push .
  env:
    # Or pre-write ~/.docker/config.json; beambox reads it.
    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

A build with no `RUN` step needs no runtime at all, so it works on any stock runner. A
build **with** `RUN` steps needs microsandbox installed on the runner.

## 9. When it fails

beambox fails loudly rather than producing an image that looks right and behaves wrong.

| Message | What to do |
| --- | --- |
| `UnsupportedInstructionError: ONBUILD (line 12)` | Rewrite the Dockerfile — refusals are deliberate, not gaps to work around |
| `RunFailedError: exit 1` | The command itself failed; the step's output is above the error |
| `NoExecutorError` | A `RUN` step with no microsandbox runtime — install `msb`, or drop the `RUN` |
| `PlatformMismatchError` | `--platform` asked for a non-host architecture *and* the build has a `RUN` step |
| `CopySourceError` | A `COPY` source matched nothing — check the path and `.dockerignore` |
| `DockerfileParseError` | Syntax error, with the line and column |

Refused by name and line number, never silently skipped: `ONBUILD`, `MAINTAINER`, `ADD`
from a URL, `RUN --mount=type=secret|ssh`, `RUN --network`, `RUN --security`, and
non-default BuildKit frontends.

## Next

- Generate images from code instead of a Dockerfile — the [library guide](./library.md)
- Teach a coding agent to do all of this — the [agent guide](./agents.md)
