import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import {
  type ExecutionContext,
  type ExecutionStep,
  type Executor,
  ExecutorError,
  type ExecutorSession,
  RunFailedError,
  type RunMount,
} from "@beambox/builder"
import {
  type BuiltLayer,
  buildLayer,
  type Platform,
  storeLayerTar,
  writeArchive,
} from "@beambox/oci"
import { hostPlatform, platformLabel } from "@beambox/registry"
import type { Sandbox } from "microsandbox"
import { ensureBusybox } from "./busybox.ts"
import { diffListings, parseListing, type RootfsEntry, repackLayerTar } from "./diff.ts"

/** Where the scratch bind mount appears inside the guest. */
const GUEST_SCRATCH = "/beambox"
const GUEST_BUSYBOX = `${GUEST_SCRATCH}/bin/busybox`

export interface MicrosandboxExecutorOptions {
  /** Memory for the build sandbox, in MiB. */
  readonly memory?: number
  readonly cpus?: number
  /** Per-step timeout in milliseconds. */
  readonly timeout?: number
  /** Where the busybox bootstrap binary is cached between builds. */
  readonly cacheDir?: string
  /** Leave the sandbox, staged image, and scratch directory in place for debugging. */
  readonly keepOnFailure?: boolean
}

/** The microsandbox SDK, imported lazily so a declarative build never loads it. */
type MicrosandboxModule = typeof import("microsandbox")

const loadSdk = async (): Promise<MicrosandboxModule> => {
  try {
    return await import("microsandbox")
  } catch (cause) {
    throw new ExecutorError(
      `RUN steps need the microsandbox runtime, but the "microsandbox" package could not be ` +
        `loaded. Install it with: bun add microsandbox`,
      { cause },
    )
  }
}

interface SessionResources {
  readonly sandbox: Sandbox
  readonly sandboxName: string
  readonly imageTag: string
  readonly hostScratch: string
}

/**
 * Runs `RUN` steps inside a microsandbox microVM.
 *
 * This is what takes Docker out of the picture: the image under construction is loaded
 * into microsandbox's own cache, booted as a microVM, and the commands execute there.
 * The layer each step produces is read out of the sandbox's overlay upper directory,
 * which by construction holds exactly what that step changed — no filesystem-wide scan
 * and no guesswork.
 *
 * A statically linked busybox is bind-mounted in from the host, so the guest needs no
 * shell, `tar`, or `find` of its own. `RUN` therefore works even on `scratch` and
 * distroless bases.
 */
export const microsandboxExecutor = (options: MicrosandboxExecutorOptions = {}): Executor => ({
  name: "microsandbox",

  supports(platform: Platform) {
    const host = hostPlatform()
    if (platform.os !== "linux") {
      return { supported: false as const, reason: `${platformLabel(host)} (guests are Linux only)` }
    }
    if (platform.architecture !== host.architecture) {
      // There is no binfmt/qemu-user layer here: the microVM runs the host's real ISA.
      return { supported: false as const, reason: platformLabel(host) }
    }
    return { supported: true as const }
  },

  async open(context: ExecutionContext): Promise<ExecutorSession> {
    const sdk = await loadSdk()
    const id = crypto.randomUUID().slice(0, 12)
    const sandboxName = `beambox-build-${id}`
    const imageTag = `beambox-build/${id}:staging`
    // Resolve symlinks: on macOS the temp dir sits under /var, itself a symlink to
    // /private/var, and the runtime's bind-mount path walk cannot follow it.
    const hostScratch = await realpath(await mkdtemp(join(tmpdir(), "beambox-run-")))

    try {
      for (const directory of ["bin", "in", "out", "state"]) {
        await mkdir(join(hostScratch, directory), { recursive: true })
      }

      // The OCI archive form keeps layers compressed, so staging costs no recompression.
      const archive = join(hostScratch, "base.oci.tar")
      await writeArchive(context.base, archive, { format: "oci", tags: [imageTag] })

      const busybox = await ensureBusybox(
        options.cacheDir ?? join(hostScratch, "cache"),
        context.platform,
        { store: context.store },
      )
      const guestBusybox = join(hostScratch, "bin", "busybox")
      await Bun.write(guestBusybox, Bun.file(busybox))
      await chmod(guestBusybox, 0o755)

      await sdk.Image.load(archive, { tag: imageTag })

      const builder = sdk.Sandbox.builder(sandboxName)
        .image(imageTag)
        .pullPolicy("never")
        .volume(GUEST_SCRATCH, (mount) => mount.bind(hostScratch))

      applyMounts(builder, context.mounts, context.contextDir)

      if (options.memory !== undefined) builder.memory(options.memory)
      if (options.cpus !== undefined) builder.cpus(options.cpus)

      const sandbox = await builder.create()

      // Fail here rather than at the first step if the bootstrap binary did not survive
      // the trip through the bind mount.
      const check = await sandbox.exec(GUEST_BUSYBOX, ["true"])
      if (check.code !== 0) {
        throw new ExecutorError(
          `The bootstrap busybox at ${GUEST_BUSYBOX} is not executable inside the sandbox ` +
            `(exit ${check.code}): ${check.stderr()}`,
        )
      }

      return createSession(sdk, { sandbox, sandboxName, imageTag, hostScratch }, context, options)
    } catch (error) {
      await cleanup(sdk, { sandboxName, imageTag, hostScratch }, options, context.onWarning)
      throw error
    }
  },
})

const cleanup = async (
  sdk: MicrosandboxModule,
  what: {
    sandbox?: Sandbox | undefined
    sandboxName: string
    imageTag: string
    hostScratch: string
  },
  options: MicrosandboxExecutorOptions,
  onWarning?: ((message: string) => void) | undefined,
): Promise<void> => {
  if (options.keepOnFailure) {
    onWarning?.(
      `Left sandbox ${what.sandboxName}, image ${what.imageTag}, and ${what.hostScratch} in ` +
        `place because keepOnFailure is set. Remove them with: msb rm ${what.sandboxName} && ` +
        `msb rmi --force ${what.imageTag}`,
    )
    return
  }

  // The runtime refuses to delete a running sandbox, so stop it first. Tidying up must
  // never mask the error that triggered it, but failing silently would leave the user
  // with stale VMs and no clue why — so each failure is reported, not swallowed.
  const attempt = async (what_: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      onWarning?.(`Could not ${what_}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (what.sandbox)
    await attempt(
      `stop sandbox ${what.sandboxName}`,
      () => what.sandbox?.stop() ?? Promise.resolve(),
    )
  await attempt(`remove sandbox ${what.sandboxName}`, () => sdk.Sandbox.remove(what.sandboxName))
  await attempt(`remove staged image ${what.imageTag}`, () =>
    sdk.Image.remove(what.imageTag, { force: true }),
  )
  await attempt(`remove ${what.hostScratch}`, () =>
    rm(what.hostScratch, { recursive: true, force: true }),
  )
}

/**
 * Translate a stage's `RUN --mount` declarations into sandbox volumes.
 *
 * These land on their own filesystems, which is exactly what makes them behave like
 * Docker's: `find / -xdev` never descends into them, so a package cache populated during
 * a build is available to later builds but never becomes part of the image.
 */
const applyMounts = (
  builder: ReturnType<MicrosandboxModule["Sandbox"]["builder"]>,
  mounts: readonly RunMount[],
  contextDir: string,
): void => {
  const seen = new Set<string>()

  for (const mount of mounts) {
    if (seen.has(mount.target)) continue
    seen.add(mount.target)

    if (mount.type === "tmpfs") {
      builder.volume(mount.target, (m) => m.tmpfs())
      continue
    }

    if (mount.type === "cache") {
      // A stable name keyed on the cache id (or its target) is what lets the same cache
      // come back on the next build.
      const key = mount.id ?? mount.target
      const name = `beambox-cache-${new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16)}`
      builder.volume(mount.target, (m) => {
        const configured = m.namedWith(name, "ensure-exists", "directory")
        return mount.readonly ? configured.readonly() : configured
      })
      continue
    }

    if (mount.from !== undefined) {
      throw new ExecutorError(
        `RUN --mount=type=bind,from=${mount.from} is not supported yet. ` +
          `Use COPY --from=${mount.from} to bring the files in instead.`,
      )
    }

    const host = join(contextDir, mount.source ?? ".")
    builder.volume(mount.target, (m) => m.bind(host).readonly())
  }
}

/** A tar containing nothing: the two zero blocks that mark end-of-archive. */
const emptyTar = (): Readable => Readable.from([new Uint8Array(1024)])

const createSession = (
  sdk: MicrosandboxModule,
  resources: SessionResources,
  context: ExecutionContext,
  options: MicrosandboxExecutorOptions,
): ExecutorSession => {
  const { sandbox, hostScratch } = resources
  let previous: RootfsEntry[] = []
  let baselineTaken = false
  let stepNumber = 0

  /**
   * Index the guest root filesystem.
   *
   * `-xdev` confines the walk to the overlay root, so every other mount — `/proc`,
   * `/sys`, `/dev`, `/tmp`, and beambox's own scratch — drops out without an exclusion
   * list that could silently go stale.
   */
  const listRootfs = async (): Promise<RootfsEntry[]> => {
    const result = await sandbox.exec(GUEST_BUSYBOX, [
      "sh",
      "-c",
      `${GUEST_BUSYBOX} find / -xdev -mindepth 1 -exec ${GUEST_BUSYBOX} stat -c '%n|%s|%Y|%f' {} +`,
    ])
    if (result.code !== 0) {
      throw new ExecutorError(
        `Could not index the sandbox filesystem (exit ${result.code}): ${result.stderr()}`,
      )
    }
    return parseListing(result.stdout())
  }

  /** The base image's own files are not a change, so establish the baseline first. */
  const ensureBaseline = async (): Promise<void> => {
    if (baselineTaken) return
    previous = await listRootfs()
    baselineTaken = true
  }

  const captureLayer = async (): Promise<BuiltLayer | undefined> => {
    const current = await listRootfs()
    const diff = diffListings(previous, current)
    previous = current
    if (diff.changed.length === 0 && diff.deleted.length === 0) return undefined

    // Only files and symlinks need their bytes read out of the guest; directories and
    // whiteouts are reconstructed on the host from the listing alone.
    const streamable = diff.changed.filter(
      (entry) => entry.kind === "file" || entry.kind === "symlink",
    )

    stepNumber += 1
    const tarName = `step-${stepNumber}.tar`
    const tarPath = join(hostScratch, "out", tarName)

    if (streamable.length > 0) {
      const listName = `step-${stepNumber}.list`
      await Bun.write(
        join(hostScratch, "state", listName),
        `${streamable.map((entry) => entry.path).join("\n")}\n`,
      )

      const result = await sandbox.exec(GUEST_BUSYBOX, [
        "tar",
        "-cf",
        `${GUEST_SCRATCH}/out/${tarName}`,
        "-C",
        "/",
        "-T",
        `${GUEST_SCRATCH}/state/${listName}`,
      ])
      if (result.code !== 0) {
        throw new ExecutorError(
          `Could not read the layer out of the sandbox (exit ${result.code}): ${result.stderr()}`,
        )
      }
    }

    const source = streamable.length > 0 ? createReadStream(tarPath) : emptyTar()
    const layer = await storeLayerTar(context.store, repackLayerTar(source, diff))
    await rm(tarPath, { force: true })
    return layer
  }

  const runStep = async (step: Extract<ExecutionStep, { kind: "run" }>): Promise<void> => {
    const [command, ...args] = step.argv
    if (command === undefined) throw new ExecutorError(`Empty command for ${step.instruction}`)

    const result = await sandbox.execWith(command, (exec) => {
      let configured = exec
        .args(args)
        .cwd(step.workdir)
        .envs({ ...step.env })
      if (step.user !== undefined) configured = configured.user(step.user)
      if (options.timeout !== undefined) configured = configured.timeout(options.timeout)
      return configured
    })

    if (result.stdout() !== "") context.onOutput?.({ stream: "stdout", text: result.stdout() })
    if (result.stderr() !== "") context.onOutput?.({ stream: "stderr", text: result.stderr() })

    if (result.code !== 0) {
      throw new RunFailedError(
        step.instruction,
        result.code,
        `${result.stdout()}${result.stderr()}`,
      )
    }
  }

  /**
   * Write files into the guest.
   *
   * The layer is built on the host — cheaper and more faithful than reading it back out —
   * and then unpacked into the sandbox so later `RUN` steps can see it. Because unpacking
   * also changes the guest filesystem, the baseline is refreshed afterwards so the next
   * step does not capture these same files a second time.
   */
  const materializeStep = async (
    step: Extract<ExecutionStep, { kind: "materialize" }>,
  ): Promise<BuiltLayer> => {
    const layer = await buildLayer(context.store, step.entries)

    stepNumber += 1
    const inputName = `materialize-${stepNumber}.tar`
    const staged = join(hostScratch, "in", inputName)
    await pipeline(layer.blob.stream().pipe(createGunzip()), createWriteStream(staged))

    const result = await sandbox.exec(GUEST_BUSYBOX, [
      "tar",
      "-xf",
      `${GUEST_SCRATCH}/in/${inputName}`,
      "-C",
      "/",
    ])
    if (result.code !== 0) {
      throw new ExecutorError(
        `Could not write ${step.instruction} into the sandbox (exit ${result.code}): ${result.stderr()}`,
      )
    }

    await rm(staged, { force: true })
    previous = await listRootfs()
    return layer
  }

  return {
    async apply(step: ExecutionStep): Promise<BuiltLayer | undefined> {
      await ensureBaseline()

      if (step.kind === "run") {
        await runStep(step)
        return await captureLayer()
      }
      return await materializeStep(step)
    },

    async close(): Promise<void> {
      await cleanup(
        sdk,
        {
          sandbox: resources.sandbox,
          sandboxName: resources.sandboxName,
          imageTag: resources.imageTag,
          hostScratch: resources.hostScratch,
        },
        { ...options, keepOnFailure: false },
        context.onWarning,
      )
    },
  }
}
