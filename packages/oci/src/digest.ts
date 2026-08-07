import { createHash } from "node:crypto"
import { Transform } from "node:stream"
import { InvalidDigestError } from "./errors.ts"

/**
 * A content-addressable digest. The template literal type means a `Digest` cannot
 * be confused with an arbitrary string at compile time.
 */
export type Digest = `sha256:${string}`

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export const isDigest = (value: string): value is Digest => DIGEST_PATTERN.test(value)

/** Parse a digest string, throwing `InvalidDigestError` if it is malformed. */
export const parseDigest = (value: string): Digest => {
  if (!isDigest(value)) throw new InvalidDigestError(value)
  return value
}

/** The hex portion of a digest, i.e. the part after `sha256:`. */
export const digestHex = (digest: Digest): string => digest.slice("sha256:".length)

/** Digest of an in-memory buffer. */
export const digestOf = (bytes: Uint8Array): Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/**
 * A pass-through stream that computes the sha256 of everything flowing through it.
 * Used to hash tar and gzip streams in a single pass rather than buffering a layer
 * in memory just to hash it.
 */
export interface HashingStream extends Transform {
  /** Total bytes observed. Final only once the stream has ended. */
  readonly bytesSeen: number
  /** The digest of everything observed. Call only after the stream has ended. */
  digest(): Digest
}

export const hashingStream = (): HashingStream => {
  const hash = createHash("sha256")
  let bytes = 0
  let finalized: Digest | undefined

  const stream = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.byteLength
      callback(null, chunk)
    },
  }) as Transform & { bytesSeen: number; digest: () => Digest }

  Object.defineProperty(stream, "bytesSeen", { get: () => bytes })
  stream.digest = () => {
    finalized ??= `sha256:${hash.digest("hex")}`
    return finalized
  }

  return stream
}
