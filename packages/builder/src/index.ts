export { type BuildEvent, type BuildOptions, build, describeOp } from "./build.ts"
export { defaultCacheDirectory, LayerCache } from "./cache.ts"
export {
  applyConfigOp,
  envToMap,
  expandOp,
  expandVariables,
  expansionScope,
  initialState,
  mapToEnv,
  type StageState,
} from "./config.ts"
export {
  extractArchive,
  type IgnoreMatcher,
  loadDockerignore,
  looksLikeArchive,
  parseDockerignore,
  resolveCopy,
} from "./context.ts"
export {
  CopySourceError,
  ExecutorError,
  NoExecutorError,
  PlatformMismatchError,
  RunFailedError,
  UnknownStageError,
} from "./errors.ts"
export type {
  ExecutionContext,
  ExecutionStep,
  Executor,
  ExecutorSession,
  MaterializeStep,
  RunStep,
} from "./executor.ts"
export {
  type BaseSource,
  type BuildOp,
  type BuildPlan,
  type Command,
  type CopySource,
  commandText,
  commandToArgv,
  DEFAULT_SHELL,
  producesLayer,
  type RunMount,
  type Stage,
} from "./spec.ts"
export { StageFilesystem } from "./stage-fs.ts"
