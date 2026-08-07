import { join } from "node:path"
import {
  assembleImage,
  type BlobStore,
  type BuiltLayer,
  buildLayer,
  type Digest,
  emptyImageConfig,
  type HistoryEntry,
  type ImageArtifact,
  type ImageConfig,
  type LayerEntry,
  type Platform,
  parseReference,
} from "@beamhop/oci"
import { hostPlatform, platformLabel, pullImage, type RegistryOptions } from "@beamhop/registry"
import { LayerCache } from "./cache.ts"
import {
  applyConfigOp,
  envToMap,
  expandOp,
  expandVariables,
  expansionScope,
  initialState,
  type StageState,
} from "./config.ts"
import {
  extractArchive,
  type IgnoreMatcher,
  loadDockerignore,
  looksLikeArchive,
  resolveCopy,
} from "./context.ts"
import {
  CopySourceError,
  NoExecutorError,
  PlatformMismatchError,
  UnknownStageError,
} from "./errors.ts"
import type { Executor, ExecutorSession } from "./executor.ts"
import { type BuildOp, type BuildPlan, commandToArgv, type Stage } from "./spec.ts"
import { StageFilesystem } from "./stage-fs.ts"

export type BuildEvent =
  | {
      readonly kind: "stage"
      readonly name: string
      readonly index: number
      readonly total: number
    }
  | {
      readonly kind: "step"
      readonly instruction: string
      readonly index: number
      readonly total: number
    }
  | { readonly kind: "cached"; readonly instruction: string }
  | { readonly kind: "pull"; readonly reference: string }
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly text: string }
  | { readonly kind: "warning"; readonly message: string }

export interface BuildOptions {
  readonly store: BlobStore
  /** Required only if the build contains `RUN` steps. */
  readonly executor?: Executor
  /** Target platform. Defaults to the host. */
  readonly platform?: Platform
  /** Directory `COPY` and `ADD` read from. Defaults to the plan's context, then cwd. */
  readonly context?: string
  readonly buildArgs?: Readonly<Record<string, string>>
  /** Pass `false` to disable the `RUN` cache. */
  readonly cache?: LayerCache | false
  readonly registry?: RegistryOptions
  readonly onProgress?: (event: BuildEvent) => void
}

/** Describes an op the way `docker history` would, for both logs and image history. */
export const describeOp = (op: BuildOp): string => {
  switch (op.kind) {
    case "run":
      return `RUN ${op.command.form === "shell" ? op.command.command : JSON.stringify(op.command.argv)}`
    case "copy":
    case "add":
      return `${op.kind.toUpperCase()} ${op.from ? `--from=${op.from} ` : ""}${op.sources.join(" ")} ${op.destination}`
    case "env":
      return `ENV ${Object.entries(op.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    case "arg":
      return `ARG ${op.name}${op.defaultValue !== undefined ? `=${op.defaultValue}` : ""}`
    case "label":
      return `LABEL ${Object.entries(op.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    case "workdir":
      return `WORKDIR ${op.path}`
    case "user":
      return `USER ${op.user}`
    case "cmd":
      return `CMD ${op.command === null ? "null" : JSON.stringify(commandToArgv(op.command, ["/bin/sh", "-c"]))}`
    case "entrypoint":
      return `ENTRYPOINT ${op.command === null ? "null" : JSON.stringify(commandToArgv(op.command, ["/bin/sh", "-c"]))}`
    case "expose":
      return `EXPOSE ${op.ports.join(" ")}`
    case "volume":
      return `VOLUME ${op.paths.join(" ")}`
    case "stopsignal":
      return `STOPSIGNAL ${op.signal}`
    case "shell":
      return `SHELL ${JSON.stringify(op.shell)}`
    case "healthcheck":
      return `HEALTHCHECK ${op.test === null ? "NONE" : JSON.stringify(op.test)}`
  }
}

/** Resolve the filesystem a stage starts from. */
const resolveBase = async (
  stage: Stage,
  built: Map<string, ImageArtifact>,
  options: BuildOptions,
  platform: Platform,
): Promise<ImageArtifact> => {
  switch (stage.base.kind) {
    case "scratch":
      return await assembleImage(options.store, { config: emptyImageConfig(platform), layers: [] })

    case "stage": {
      const previous = built.get(stage.base.stage)
      if (!previous) throw new UnknownStageError(stage.base.stage, [...built.keys()])
      return previous
    }

    case "registry": {
      // `FROM ${BASE}` resolves here rather than at parse time, so a --build-arg passed
      // at build time still overrides the Dockerfile's default.
      const reference = expandVariables(stage.base.reference, options.buildArgs ?? {})
      options.onProgress?.({ kind: "pull", reference })
      return await pullImage(options.store, parseReference(reference), {
        ...options.registry,
        platform,
      })
    }
  }
}

/** A base image's config carries forward, but its history and layer list belong to it. */
const inheritConfig = (base: ImageArtifact, platform: Platform): ImageConfig => ({
  ...base.config,
  architecture: platform.architecture,
  os: platform.os,
  rootfs: { type: "layers", diff_ids: [] },
})

/**
 * Where a `COPY --from` reads its files.
 *
 * Copying out of an earlier stage means reading that stage's filesystem, which lives in
 * layers rather than on the host — so it is the executor's job, not the context walker's.
 */
const copyFromStage = (op: BuildOp): string | undefined =>
  (op.kind === "copy" || op.kind === "add") && op.from !== undefined ? op.from : undefined

/** `--chown` on a stage copy. Names would need the source image's /etc/passwd. */
const parseNumericChown = (chown: string): { uid: number; gid: number } => {
  const [user = "", group = user] = chown.split(":")
  const uid = Number(user)
  const gid = Number(group)
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new CopySourceError(chown, `must use numeric IDs (for example --chown=1000:1000).`)
  }
  return { uid, gid }
}

interface StepOutcome {
  readonly layer?: BuiltLayer | undefined
  readonly state: StageState
}

const buildStage = async (
  stage: Stage,
  stageIndex: number,
  totalStages: number,
  built: Map<string, ImageArtifact>,
  options: BuildOptions,
  contextDir: string,
  ignore: IgnoreMatcher,
  cache: LayerCache | undefined,
): Promise<ImageArtifact> => {
  const platform = stage.platform ?? options.platform ?? hostPlatform()
  options.onProgress?.({
    kind: "stage",
    name: stage.name ?? `stage-${stageIndex}`,
    index: stageIndex,
    total: totalStages,
  })

  // Mounts are fixed when a sandbox is created, so collect the whole stage's set now.
  const stageMounts = stage.ops.flatMap((op) => (op.kind === "run" ? [...(op.mounts ?? [])] : []))

  const base = await resolveBase(stage, built, options, platform)
  const layers: BuiltLayer[] = [...base.layers]
  const history: HistoryEntry[] = [...(base.config.history ?? [])]

  let state = initialState(inheritConfig(base, platform), { ...options.buildArgs })
  let session: ExecutorSession | undefined

  /** The image as built so far — what a sandbox must boot from. */
  const currentImage = async (): Promise<ImageArtifact> =>
    await assembleImage(options.store, { config: { ...state.config, history }, layers })

  const openSession = async (instruction: string): Promise<ExecutorSession> => {
    if (session) return session
    const executor = options.executor
    if (!executor) throw new NoExecutorError(instruction)

    const support = executor.supports(platform)
    if (!support.supported) {
      throw new PlatformMismatchError(platformLabel(platform), support.reason)
    }

    session = await executor.open({
      store: options.store,
      platform,
      base: await currentImage(),
      mounts: stageMounts,
      contextDir,
      ...(options.onProgress
        ? {
            onOutput: (chunk: { stream: "stdout" | "stderr"; text: string }) =>
              options.onProgress?.({ kind: "output", ...chunk }),
            onWarning: (message: string) => options.onProgress?.({ kind: "warning", message }),
          }
        : {}),
    })
    return session
  }

  const ops = stage.ops
  // The sandbox must be released even when a step throws, or a failed build leaves a
  // stopped VM and a staged image behind on the user's machine.
  try {
    for (const [index, rawOp] of ops.entries()) {
      const op = expandOp(rawOp, expansionScope(state))
      const instruction = describeOp(op)
      options.onProgress?.({ kind: "step", instruction, index, total: ops.length })

      const outcome = await applyOp({
        op,
        instruction,
        state,
        layers,
        contextDir,
        ignore,
        options,
        cache,
        built,
        // A sandbox is only needed while more RUN steps are coming; once none remain, close
        // it so trailing COPYs build on the host, which is far cheaper than writing through
        // a virtiofs mount.
        remainingRuns: ops.slice(index + 1).some((later) => later.kind === "run"),
        session,
        openSession,
        closeSession: async () => {
          if (session) {
            await session.close()
            session = undefined
          }
        },
        currentImage,
      })

      state = outcome.state
      if (outcome.layer) layers.push(outcome.layer)
      history.push({
        created_by: instruction,
        ...(outcome.layer ? {} : { empty_layer: true }),
      })
    }
  } finally {
    if (session) await session.close()
  }

  return await assembleImage(options.store, { config: { ...state.config, history }, layers })
}

interface ApplyContext {
  op: BuildOp
  instruction: string
  state: StageState
  layers: BuiltLayer[]
  contextDir: string
  ignore: IgnoreMatcher
  options: BuildOptions
  cache: LayerCache | undefined
  built: Map<string, ImageArtifact>
  remainingRuns: boolean
  session: ExecutorSession | undefined
  openSession: (instruction: string) => Promise<ExecutorSession>
  closeSession: () => Promise<void>
  currentImage: () => Promise<ImageArtifact>
}

const applyOp = async (context: ApplyContext): Promise<StepOutcome> => {
  const { op, instruction, state, options } = context

  if (op.kind === "copy" || op.kind === "add") {
    const entries: LayerEntry[] = []
    const fromStage = copyFromStage(op)

    if (fromStage !== undefined) {
      const source = context.built.get(fromStage)
      if (!source) throw new UnknownStageError(fromStage, [...context.built.keys()])

      const filesystem = await StageFilesystem.open(source.layers)
      entries.push(
        ...(await filesystem.resolve(op.sources, op.destination, {
          ...(op.chown !== undefined ? { chown: parseNumericChown(op.chown) } : {}),
          ...(op.chmod !== undefined ? { chmod: Number.parseInt(op.chmod, 8) } : {}),
        })),
      )
    } else if (
      op.kind === "add" &&
      op.sources.length === 1 &&
      looksLikeArchive(op.sources[0] ?? "")
    ) {
      entries.push(
        ...(await extractArchive(join(context.contextDir, op.sources[0] ?? ""), op.destination)),
      )
    } else {
      entries.push(...(await resolveCopy(context.contextDir, op, context.ignore)))
    }

    // While a sandbox is open and more RUN steps follow, the files have to land inside it.
    if (context.session && context.remainingRuns) {
      const layer = await context.session.apply({ kind: "materialize", entries, instruction })
      return { layer: layer ?? undefined, state }
    }

    if (context.session) await context.closeSession()
    return { layer: await buildLayer(options.store, entries), state }
  }

  if (op.kind === "run") {
    const parent: Digest = (await context.currentImage()).manifestDescriptor.digest
    const mounts = op.mounts ?? []
    const key = LayerCache.key(parent, instruction, mounts)

    const cached = await context.cache?.get(key)
    if (cached) {
      options.onProgress?.({ kind: "cached", instruction })
      return { layer: cached, state }
    }

    const session = await context.openSession(instruction)
    const layer = await session.apply({
      kind: "run",
      argv: commandToArgv(op.command, state.shell),
      env: { ...envToMap(state.config.config?.Env), ...(op.env ?? {}) },
      workdir: state.config.config?.WorkingDir ?? "/",
      ...(state.config.config?.User !== undefined ? { user: state.config.config.User } : {}),
      mounts,
      instruction,
    })

    if (layer && context.cache) await context.cache.set(key, layer)
    return { layer: layer ?? undefined, state }
  }

  return { state: applyConfigOp(state, op) }
}

/**
 * Run a build plan and return the finished image.
 *
 * Stages are built in order and each is available to later ones by name. A build with no
 * `RUN` steps never touches an executor, so it works with no runtime installed at all.
 */
export const build = async (plan: BuildPlan, options: BuildOptions): Promise<ImageArtifact> => {
  const contextDir = options.context ?? plan.context ?? process.cwd()
  const ignore = await loadDockerignore(contextDir)
  const cache = options.cache === false ? undefined : (options.cache ?? undefined)

  const targetIndex =
    plan.target === undefined
      ? plan.stages.length - 1
      : plan.stages.findIndex((stage) => stage.name === plan.target)

  if (targetIndex === -1) {
    throw new UnknownStageError(
      plan.target ?? "",
      plan.stages.map((stage) => stage.name).filter((name): name is string => name !== undefined),
    )
  }

  const built = new Map<string, ImageArtifact>()
  let result: ImageArtifact | undefined

  for (let index = 0; index <= targetIndex; index += 1) {
    const stage = plan.stages[index]
    if (!stage) continue

    const artifact = await buildStage(
      stage,
      index,
      plan.stages.length,
      built,
      { ...options, buildArgs: { ...plan.buildArgs, ...options.buildArgs } },
      contextDir,
      ignore,
      cache,
    )

    if (stage.name !== undefined) built.set(stage.name, artifact)
    result = artifact
  }

  if (!result) throw new UnknownStageError(plan.target ?? "", [])
  return result
}
