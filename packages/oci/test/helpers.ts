import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import { extract } from "tar-stream"
import { BlobStore } from "../src/blob.ts"

/** A temporary blob store, plus its cleanup. Tests use real files, never a stub. */
export const withStore = async (): Promise<{
  store: BlobStore
  dir: string
  cleanup: () => Promise<void>
}> => {
  const dir = await mkdtemp(join(tmpdir(), "beambox-test-"))
  return {
    store: new BlobStore(join(dir, "blobs")),
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export interface TarEntry {
  readonly name: string
  readonly type: string
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly mtimeMs: number
  readonly linkname: string | null
  readonly content: Uint8Array
}

/** Read a tar stream into a list of entries, so tests can assert on real archive bytes. */
export const readTar = async (
  source: Readable,
  options?: { gzip?: boolean },
): Promise<TarEntry[]> => {
  const entries: TarEntry[] = []
  const parser = extract()

  parser.on("entry", (header, stream, next) => {
    const chunks: Uint8Array[] = []
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    stream.on("end", () => {
      entries.push({
        name: header.name,
        type: String(header.type),
        mode: header.mode ?? 0,
        uid: header.uid ?? 0,
        gid: header.gid ?? 0,
        mtimeMs: header.mtime?.getTime() ?? -1,
        linkname: header.linkname ?? null,
        content: Buffer.concat(chunks),
      })
      next()
    })
    stream.resume()
  })

  const input = options?.gzip ? source.pipe(createGunzip()) : source
  await new Promise<void>((resolve, reject) => {
    parser.on("finish", resolve)
    parser.on("error", reject)
    input.on("error", reject)
    input.pipe(parser)
  })

  return entries
}

export const readTarFromFile = (path: string, options?: { gzip?: boolean }): Promise<TarEntry[]> =>
  readTar(Readable.fromWeb(Bun.file(path).stream() as never), options)

export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
