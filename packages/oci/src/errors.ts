/**
 * Every failure in beambox is a typed error carrying enough context to act on.
 * Nothing is swallowed; nothing throws a bare `Error`.
 */
export abstract class BeamboxError extends Error {
  abstract readonly code: string

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A digest string was not a well-formed `sha256:<64 hex chars>`. */
export class InvalidDigestError extends BeamboxError {
  readonly code = "INVALID_DIGEST"

  constructor(readonly value: string) {
    super(`Not a valid digest: ${JSON.stringify(value)}. Expected "sha256:" + 64 hex characters.`)
  }
}

/** Content did not hash to the digest that referenced it. */
export class DigestMismatchError extends BeamboxError {
  readonly code = "DIGEST_MISMATCH"

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Digest mismatch: expected ${expected}, computed ${actual}.`)
  }
}

/** A manifest, index, or image config failed schema validation. */
export class ManifestError extends BeamboxError {
  readonly code = "MANIFEST_INVALID"
}

/** An archive on disk was not a readable docker-save or OCI layout archive. */
export class ArchiveError extends BeamboxError {
  readonly code = "ARCHIVE_INVALID"
}

/** An image reference could not be parsed. */
export class InvalidReferenceError extends BeamboxError {
  readonly code = "INVALID_REFERENCE"

  constructor(
    readonly value: string,
    detail: string,
  ) {
    super(`Invalid image reference ${JSON.stringify(value)}: ${detail}`)
  }
}

/** A blob was requested from a store that does not hold it. */
export class BlobNotFoundError extends BeamboxError {
  readonly code = "BLOB_NOT_FOUND"

  constructor(readonly digest: string) {
    super(`Blob not found: ${digest}`)
  }
}
