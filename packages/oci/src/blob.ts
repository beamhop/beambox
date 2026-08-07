import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { type Digest, digestHex, digestOf, hashingStream } from "./digest.ts"
import { BlobNotFoundError, DigestMismatchError } from "./errors.ts"

/**
 * A content-addressed chunk of bytes. Layers routinely run to hundreds of megabytes,
 * so a blob is a *handle* that can be opened as a stream — never the bytes themselves.
 * Small blobs (configs, manifests) can still be read whole via `bytes()`.
 */
export interface Blob {
  readonly digest: Digest
  readonly size: number
  /** Open the blob for reading. Safe to call more than once. */
  stream(): Readable
  /** Read the whole blob into memory. Only sensible for small documents. */
  bytes(): Promise<Uint8Array>
}

export const blobFromBytes = (data: Uint8Array): Blob => {
  const digest = digestOf(data)
  return {
    digest,
    size: data.byteLength,
    stream: () => Readable.from([data]),
    bytes: async () => data,
  }
}

export const blobFromFile = (path: string, digest: Digest, size: number): Blob => ({
  digest,
  size,
  stream: () => createReadStream(path),
  bytes: async () => new Uint8Array(await Bun.file(path).arrayBuffer()),
})

/**
 * A content-addressed store on disk, laid out as `<root>/sha256/<hex>`.
 *
 * This is both the build cache and the staging area for archives and pushes: a layer is
 * written once, hashed on the way in, and thereafter referred to only by digest. Writing
 * the same content twice is a no-op, which is what makes rebuilds cheap.
 */
export class BlobStore {
  constructor(private readonly root: string) {}

  /** Absolute path where a digest's bytes live, whether or not they exist yet. */
  path(digest: Digest): string {
    return join(this.root, "sha256", digestHex(digest))
  }

  async has(digest: Digest): Promise<boolean> {
    return await Bun.file(this.path(digest)).exists()
  }

  async get(digest: Digest): Promise<Blob> {
    const path = this.path(digest)
    const info = await stat(path).catch(() => undefined)
    if (!info) throw new BlobNotFoundError(digest)
    return blobFromFile(path, digest, info.size)
  }

  /**
   * Stream content in, hashing as it goes, and commit it under its own digest.
   *
   * The write lands on a temp file first and is renamed into place only once the digest
   * is known, so a crash mid-write can never leave a truncated blob claiming a valid
   * digest. Pass `expect` to verify content fetched from somewhere untrusted.
   */
  async put(source: Readable, options?: { expect?: Digest }): Promise<Blob> {
    await mkdir(join(this.root, "sha256"), { recursive: true })

    const temp = join(this.root, "sha256", `.tmp-${crypto.randomUUID()}`)
    const hasher = hashingStream()

    try {
      await pipeline(source, hasher, createWriteStream(temp))

      const digest = hasher.digest()
      const size = hasher.bytesSeen

      if (options?.expect && options.expect !== digest) {
        throw new DigestMismatchError(options.expect, digest)
      }

      const final = this.path(digest)
      // Already present: identical content by definition, so keep the original.
      if (await Bun.file(final).exists()) {
        await rm(temp, { force: true })
      } else {
        await mkdir(dirname(final), { recursive: true })
        await rename(temp, final)
      }

      return blobFromFile(final, digest, size)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  async putBytes(data: Uint8Array): Promise<Blob> {
    return await this.put(Readable.from([data]))
  }
}
