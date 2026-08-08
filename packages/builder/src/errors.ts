import { BeamboxError } from "@beamhop/oci"

/** A `RUN` step was requested but no executor was configured to run it. */
export class NoExecutorError extends BeamboxError {
  readonly code = "NO_EXECUTOR"

  constructor(readonly instruction: string) {
    super(
      `This build has a RUN step (${instruction}) but no executor was configured.\n` +
        `RUN steps execute inside a microsandbox microVM. Either pass an executor:\n` +
        `  import { microsandboxExecutor } from "@beamhop/vm-executor"\n` +
        `  build(plan, { store, executor: microsandboxExecutor() })\n` +
        `or remove the RUN steps to keep the build fully declarative.`,
    )
  }
}

/**
 * A `RUN` step was requested for a platform this machine cannot execute.
 *
 * microsandbox boots native microVMs with no emulation layer, so a build containing
 * `RUN` can only target the host architecture.
 */
export class PlatformMismatchError extends BeamboxError {
  readonly code = "PLATFORM_MISMATCH"

  constructor(
    readonly wanted: string,
    readonly host: string,
  ) {
    super(
      `Cannot execute RUN steps for ${wanted} on a ${host} host. microsandbox boots native ` +
        `microVMs and does not emulate other architectures.\n` +
        `Either build for ${host}, or drop the RUN steps — declarative builds ` +
        `(COPY/ENV/CMD/…) can target any platform because nothing is executed.`,
    )
  }
}

/** A `RUN` step exited non-zero. */
export class RunFailedError extends BeamboxError {
  readonly code = "RUN_FAILED"

  constructor(
    readonly instruction: string,
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(
      `RUN failed with exit code ${exitCode}: ${instruction}` +
        (output.trim() ? `\n\n${output.trimEnd()}` : ""),
    )
  }
}

/** A `COPY` or `ADD` matched nothing. */
export class CopySourceError extends BeamboxError {
  readonly code = "COPY_SOURCE"

  constructor(
    readonly pattern: string,
    detail: string,
  ) {
    super(`COPY source ${JSON.stringify(pattern)} ${detail}`)
  }
}

/** A stage referred to another stage that does not exist or is not yet built. */
export class UnknownStageError extends BeamboxError {
  readonly code = "UNKNOWN_STAGE"

  constructor(
    readonly stage: string,
    readonly known: readonly string[],
  ) {
    super(
      `Unknown build stage ${JSON.stringify(stage)}. ` +
        `Defined stages: ${known.length > 0 ? known.join(", ") : "(none)"}`,
    )
  }
}

/** The executor could not prepare or drive a sandbox. */
export class ExecutorError extends BeamboxError {
  readonly code = "EXECUTOR"
}
