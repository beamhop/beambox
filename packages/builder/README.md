# @beambox/builder

The beambox build engine: stages, layer assembly, caching, and the executor interface that
`RUN` steps plug into.

Most people want [`beambox`](../beambox), which wraps this with a fluent API and sensible
defaults. Reach for this package directly when you are generating build plans
programmatically or writing your own executor.

```bash
bun add @beambox/builder
```

## A build plan

A plan is data. Nothing here is fluent, and nothing is hidden.

```ts
import { BlobStore } from "@beambox/oci"
import { build } from "@beambox/builder"

const store = new BlobStore("./cache/blobs")

const image = await build(
  {
    stages: [
      {
        base: { kind: "registry", reference: "alpine:3.20" },
        ops: [
          { kind: "copy", sources: ["dist"], destination: "/app" },
          { kind: "env", values: { NODE_ENV: "production" } },
          { kind: "workdir", path: "/app" },
          { kind: "cmd", command: { form: "exec", argv: ["/app/server"] } },
        ],
      },
    ],
  },
  { store, context: "." },
)
```

No `RUN` steps means no executor is needed and no VM is booted. `build` returns a plain
`ImageArtifact` from `@beambox/oci`, ready for the archive writers or the registry pusher.

## Stages

```ts
const plan = {
  stages: [
    {
      name: "builder",
      base: { kind: "registry", reference: "node:22" },
      ops: [
        { kind: "copy", sources: ["."], destination: "/src" },
        { kind: "run", command: { form: "shell", command: "npm ci && npm run build" } },
      ],
    },
    {
      base: { kind: "registry", reference: "node:22-slim" },
      ops: [{ kind: "copy", from: "builder", sources: ["/src/dist"], destination: "/app" }],
    },
  ],
  target: undefined, // or a stage name, as `docker build --target` does
}
```

`base` can be `{ kind: "scratch" }`, `{ kind: "registry", reference }`, or
`{ kind: "stage", stage }`. `COPY --from` reads a finished stage's filesystem by replaying
its layers and applying whiteouts — see `StageFilesystem`.

## Writing an executor

The engine never imports microsandbox. It talks to this interface, which is why a
`RUN`-free build has no runtime dependency and why the engine is testable without booting
anything.

```ts
import type { Executor, ExecutorSession } from "@beambox/builder"

export const myExecutor: Executor = {
  name: "my-executor",

  supports(platform) {
    return platform.os === "linux" ? { supported: true } : { supported: false, reason: "linux only" }
  },

  async open(context): Promise<ExecutorSession> {
    // context.base is the image so far; context.mounts is every mount this stage declares.
    return {
      async apply(step) {
        if (step.kind === "run") {
          // Execute step.argv, then return a layer of what changed — or undefined if nothing did.
        }
        // step.kind === "materialize": write step.entries so later RUN steps can see them.
        return undefined
      },
      async close() {},
    }
  },
}
```

One session is opened per stage, at the first `RUN`, and closed when the stage ends —
including when a step throws. A `COPY` between two `RUN` steps is routed through the
session so the next command actually sees the files; a trailing `COPY` with no `RUN` after
it closes the session first and builds on the host, which is far cheaper.

## Caching

Only `RUN` is cached, keyed on the parent image digest plus the exact step. `COPY` and
`ADD` build their layer on the host anyway, and the blob store already deduplicates
identical content by digest, so a cache entry would save nothing.

```ts
import { LayerCache, defaultCacheDirectory } from "@beambox/builder"

const cache = new LayerCache(store, `${defaultCacheDirectory()}/run-cache.json`)
await build(plan, { store, executor, cache })
await build(plan, { store, executor, cache: false }) // ignore it
```

A cache index that outlives its blobs is a miss, not a failure.

## Progress

```ts
await build(plan, {
  store,
  executor,
  onProgress: (event) => {
    switch (event.kind) {
      case "stage":   return console.log(`stage ${event.index + 1}/${event.total}`)
      case "step":    return console.log(`  ${event.instruction}`)
      case "cached":  return console.log(`  (cached)`)
      case "pull":    return console.log(`  pulling ${event.reference}`)
      case "output":  return process.stderr.write(event.text)
      case "warning": return console.warn(event.message)
    }
  },
})
```

## Build context

`resolveCopy` implements Dockerfile's destination rules — copying a directory contributes
its *contents*, and a destination ending in `/` or any copy with several sources is treated
as a directory. `.dockerignore` is order-sensitive, so a later `!pattern` re-includes.

```ts
import { loadDockerignore, parseDockerignore, resolveCopy } from "@beambox/builder"

const ignore = parseDockerignore("node_modules\n*.log\n!keep.log\n")
ignore.ignores("node_modules/x") // true
ignore.ignores("keep.log")       // false
```
