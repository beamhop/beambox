import { BeamboxError } from "@beamhop/oci"

/** The Dockerfile could not be parsed. Always carries the line it failed on. */
export class DockerfileParseError extends BeamboxError {
  readonly code = "DOCKERFILE_PARSE"

  constructor(
    readonly line: number,
    readonly detail: string,
    readonly source?: string,
  ) {
    super(`Dockerfile line ${line}: ${detail}${source ? `\n  ${source.trim()}` : ""}`)
  }
}

/**
 * The instruction is real Dockerfile syntax that beambox does not implement.
 *
 * These are reported rather than skipped: an ignored instruction produces an image that
 * looks fine and behaves wrongly, which is far worse than a build that stops and says so.
 */
export class UnsupportedInstructionError extends BeamboxError {
  readonly code = "DOCKERFILE_UNSUPPORTED"

  constructor(
    readonly instruction: string,
    readonly line: number,
    readonly reason: string,
  ) {
    super(`Dockerfile line ${line}: ${instruction} is not supported. ${reason}`)
  }
}
