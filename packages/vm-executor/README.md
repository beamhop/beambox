# @beamhop/vm-executor

Execute Dockerfile `RUN` steps inside a [microsandbox](https://microsandbox.dev) microVM,
and load finished images straight into its cache. This is the piece that removes Docker
from the build.

```bash
bun add @beamhop/vm-executor microsandbox
```

## Loading an image into microsandbox

The handoff the whole project exists for: an image goes from beambox to a runnable microVM
with no registry, no daemon, and no Docker in the path.

```ts
import { loadIntoMicrosandbox } from "@beamhop/vm-executor"

const loaded = await loadIntoMicrosandbox(image, { tags: ["app:local"] })
console.log(loaded[0]?.reference) // "app:local"
```

```bash
msb run app:local
```

An archive is written to a temp file, imported via the microsandbox SDK, and deleted. The
OCI layout form is used by default because it keeps layers compressed and so costs no
recompression; pass `{ format: "docker" }` for a `docker save` archive instead.

## The `RUN` executor

```ts
import { build } from "@beamhop/builder"
import { microsandboxExecutor } from "@beamhop/vm-executor"

const image = await build(plan, {
  store,
  executor: microsandboxExecutor({ memory: 2048, cpus: 2, timeout: 600_000 }),
})
```

Options: `memory` (MiB), `cpus`, `timeout` (ms per step), `cacheDir` for the busybox
bootstrap binary, and `keepOnFailure` to leave the sandbox and staged image in place for
debugging.

## How it works

For each stage:

1. The image built so far is written to an OCI archive and `Image.load`ed into
   microsandbox's cache under a temporary tag.
2. A sandbox is created from it, with a host scratch directory bind-mounted at `/beambox`
   so layer tars land directly on the host instead of being streamed through the agent.
3. A statically linked busybox is placed in that scratch directory — pulled from
   `busybox:musl` through beambox's own registry client, then cached. The guest therefore
   needs no shell, `tar`, or `find` of its own, so `RUN` works on `scratch` and distroless
   bases too.
4. Each step runs, and the layer it produced is captured.
5. On close the sandbox is stopped and removed, the staged image is deleted, and the
   scratch directory is cleaned up — including when a step failed.

### Capturing what a step changed

microsandbox composes the sandbox root as an overlay whose writable upper *would* be the
layer diff exactly — but that upper is not reachable from inside the guest, so it cannot be
read directly. Instead the root filesystem is indexed before and after each step and the
listings compared.

`find -xdev` keeps the walk on the overlay itself. `/proc`, `/sys`, `/dev`, `/tmp`, cache
mounts, and beambox's own scratch mount are each a separate filesystem, so they drop out
for free rather than needing an exclusion list that could drift — and that is also why a
`RUN --mount=type=cache` never leaks into the image.

Deletions become OCI `.wh.` whiteouts, so `rm` inside a `RUN` behaves exactly as it does
under Docker. Directories are synthesised from the listing rather than handed to `tar`,
which would otherwise recurse and drag unchanged files from earlier steps into the layer.

The diff functions are pure and exported, so this logic is testable without a VM:

```ts
import { diffListings, parseListing, repackLayerTar } from "@beamhop/vm-executor"

const before = parseListing(await snapshotOne())
const after = parseListing(await snapshotTwo())
const diff = diffListings(before, after)

diff.changed  // entries that appeared or changed
diff.deleted  // paths that vanished, collapsed to subtree roots
```

## Mounts

`RUN --mount` declarations become sandbox volumes. Because a sandbox takes its mounts at
creation time, the whole stage's set is collected up front.

- `type=cache` becomes a named volume keyed on the mount's `id`, so a package cache
  survives across builds.
- `type=tmpfs` becomes an in-memory filesystem.
- `type=bind` becomes a read-only bind mount from the build context.

## Limits

- **Host architecture only.** microsandbox boots native microVMs with no emulation layer,
  so `supports()` rejects a foreign architecture and the build fails with
  `PlatformMismatchError` rather than mislabelling the image.
- **Change detection uses size, mtime, and mode.** Content rewritten in place with all
  three preserved would not be detected.
- **`RUN --mount=type=bind,from=…` is not implemented.** Use `COPY --from` instead; the
  error says so.
