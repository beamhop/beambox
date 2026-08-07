import { join } from "node:path"
import {
  type BuildEvent,
  type BuildOp,
  type BuildPlan,
  build,
  type Command,
  defaultCacheDirectory,
  type Executor,
  LayerCache,
  type RunMount,
  type Stage,
} from "@beamhop/builder"
import { microsandboxExecutor } from "@beamhop/microsandbox"
import { BlobStore, type Platform } from "@beamhop/oci"
import type { RegistryOptions } from "@beamhop/registry"
import { asBuiltImage, type BuiltImage } from "./result.ts"

export interface BuildSettings {
  /** Directory `COPY` and `ADD` read from. Defaults to the current directory. */
  readonly context?: string
  /** Tags applied to archives, layout directories, and cache loads. */
  readonly tags?: readonly string[]
  readonly platform?: Platform
  readonly buildArgs?: Readonly<Record<string, string>>
  /** Where layers and the build cache live. Defaults to `~/.cache/beambox`. */
  readonly cacheDir?: string
  /** Disable the `RUN` cache. */
  readonly noCache?: boolean
  /** Override the `RUN` executor. Defaults to microsandbox. */
  readonly executor?: Executor
  readonly registry?: RegistryOptions
  readonly onProgress?: (event: BuildEvent) => void
}

/** Accepts either Dockerfile form: a shell string, or argv for direct execution. */
export type CommandInput = string | readonly string[]

const toCommand = (input: CommandInput): Command =>
  typeof input === "string" ? { form: "shell", command: input } : { form: "exec", argv: input }

export interface CopySettings {
  /** Copy out of a named stage rather than the build context. */
  readonly from?: string
  /** `--chown`, as numeric IDs, e.g. `"1000:1000"`. */
  readonly chown?: string
  /** `--chmod`, as an octal string, e.g. `"755"`. */
  readonly chmod?: string
}

export interface RunSettings {
  readonly mounts?: readonly RunMount[]
  /** Extra environment for this step only. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * An immutable image description.
 *
 * Every method returns a new spec rather than mutating this one, so a spec can be shared,
 * branched, and reused without a later call reaching back and changing an earlier result.
 */
export class ImageSpec {
  private constructor(private readonly stages: readonly Stage[]) {}

  /** Start a spec from a base image. `"scratch"` starts from an empty filesystem. */
  static from(base: string, options: { as?: string; platform?: Platform } = {}): ImageSpec {
    return new ImageSpec([ImageSpec.stageFor(base, options)])
  }

  private static stageFor(
    base: string,
    options: { as?: string; platform?: Platform },
    known: readonly Stage[] = [],
  ): Stage {
    return {
      ...(options.as !== undefined ? { name: options.as } : {}),
      base:
        base === "scratch"
          ? { kind: "scratch" }
          : known.some((stage) => stage.name === base)
            ? { kind: "stage", stage: base }
            : { kind: "registry", reference: base },
      ops: [],
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    }
  }

  /** Begin a new build stage. Later stages can `copy` from earlier named ones. */
  stage(base: string, options: { as?: string; platform?: Platform } = {}): ImageSpec {
    return new ImageSpec([...this.stages, ImageSpec.stageFor(base, options, this.stages)])
  }

  private with(op: BuildOp): ImageSpec {
    const last = this.stages[this.stages.length - 1]
    if (!last) throw new Error("ImageSpec has no stage to add to")
    return new ImageSpec([...this.stages.slice(0, -1), { ...last, ops: [...last.ops, op] }])
  }

  /** Copy files from the build context, or from an earlier stage with `{ from }`. */
  copy(
    sources: string | readonly string[],
    destination: string,
    options: CopySettings = {},
  ): ImageSpec {
    return this.with({
      kind: "copy",
      sources: typeof sources === "string" ? [sources] : sources,
      destination,
      ...options,
    })
  }

  /** Like `copy`, but a local tar archive is expanded into the destination. */
  add(
    sources: string | readonly string[],
    destination: string,
    options: CopySettings = {},
  ): ImageSpec {
    return this.with({
      kind: "add",
      sources: typeof sources === "string" ? [sources] : sources,
      destination,
      ...options,
    })
  }

  /** Execute a command in a microVM and capture what it changed as a layer. */
  run(command: CommandInput, options: RunSettings = {}): ImageSpec {
    return this.with({
      kind: "run",
      command: toCommand(command),
      ...(options.mounts !== undefined ? { mounts: options.mounts } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
  }

  env(values: Readonly<Record<string, string>>): ImageSpec {
    return this.with({ kind: "env", values })
  }

  arg(name: string, defaultValue?: string): ImageSpec {
    return this.with({ kind: "arg", name, ...(defaultValue !== undefined ? { defaultValue } : {}) })
  }

  label(values: Readonly<Record<string, string>>): ImageSpec {
    return this.with({ kind: "label", values })
  }

  workdir(path: string): ImageSpec {
    return this.with({ kind: "workdir", path })
  }

  user(user: string): ImageSpec {
    return this.with({ kind: "user", user })
  }

  cmd(command: CommandInput | null): ImageSpec {
    return this.with({ kind: "cmd", command: command === null ? null : toCommand(command) })
  }

  entrypoint(command: CommandInput | null): ImageSpec {
    return this.with({ kind: "entrypoint", command: command === null ? null : toCommand(command) })
  }

  expose(...ports: readonly (string | number)[]): ImageSpec {
    return this.with({ kind: "expose", ports: ports.map(String) })
  }

  volume(...paths: readonly string[]): ImageSpec {
    return this.with({ kind: "volume", paths })
  }

  stopSignal(signal: string): ImageSpec {
    return this.with({ kind: "stopsignal", signal })
  }

  /** The shell used to interpret string-form `run`, `cmd`, and `entrypoint`. */
  shell(shell: readonly string[]): ImageSpec {
    return this.with({ kind: "shell", shell })
  }

  healthcheck(
    test: readonly string[] | null,
    options: { interval?: number; timeout?: number; startPeriod?: number; retries?: number } = {},
  ): ImageSpec {
    return this.with({ kind: "healthcheck", test, ...options })
  }

  /** The plan this spec describes, for inspection or for passing to the engine directly. */
  toPlan(): BuildPlan {
    return { stages: this.stages }
  }

  build(settings: BuildSettings = {}): Promise<BuiltImage> {
    return buildPlan(this.toPlan(), settings)
  }
}

/**
 * Run a build plan and return the finished image.
 *
 * Defaults are chosen so the common case needs no configuration: layers cache under
 * `~/.cache/beambox`, and `RUN` steps execute in microsandbox. A plan with no `RUN` steps
 * never touches the executor, so it works with no runtime installed.
 */
export const buildPlan = async (
  plan: BuildPlan,
  settings: BuildSettings = {},
): Promise<BuiltImage> => {
  const cacheDir = settings.cacheDir ?? defaultCacheDirectory()
  const store = new BlobStore(join(cacheDir, "blobs"))

  const artifact = await build(plan, {
    store,
    executor: settings.executor ?? microsandboxExecutor({ cacheDir }),
    cache: settings.noCache ? false : new LayerCache(store, join(cacheDir, "run-cache.json")),
    ...(settings.context !== undefined ? { context: settings.context } : {}),
    ...(settings.platform !== undefined ? { platform: settings.platform } : {}),
    ...(settings.buildArgs !== undefined ? { buildArgs: settings.buildArgs } : {}),
    ...(settings.registry !== undefined ? { registry: settings.registry } : {}),
    ...(settings.onProgress !== undefined ? { onProgress: settings.onProgress } : {}),
  })

  return asBuiltImage(artifact, settings.tags ?? [])
}

/** Start an image spec from a base image. */
export const image = (
  base: string,
  options: { as?: string; platform?: Platform } = {},
): ImageSpec => ImageSpec.from(base, options)
