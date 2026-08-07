import { createReadStream } from "node:fs"
import { PassThrough, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import { pack as tarPack } from "tar-stream"
import type { Blob, BlobStore } from "./blob.ts"
import { type Digest, hashingStream } from "./digest.ts"
import { OCI_LAYER_GZIP, OCI_LAYER_TAR } from "./media-types.ts"

/** Bytes from disk, streamed rather than buffered. */
export interface FileSource {
  readonly file: string
  readonly size: number
}

interface EntryAttributes {
  readonly path: string
  readonly mode?: number
  readonly uid?: number
  readonly gid?: number
  readonly mtime?: Date
}

export type LayerEntry =
  | (EntryAttributes & { readonly kind: "file"; readonly content: Uint8Array | FileSource })
  | (EntryAttributes & { readonly kind: "directory" })
  | (EntryAttributes & { readonly kind: "symlink"; readonly target: string })
  /** Marks `path` as deleted relative to the layers below, via a `.wh.` marker. */
  | { readonly kind: "whiteout"; readonly path: string }
  /** Marks `path` as hiding everything below it, via a `.wh..wh..opq` marker. */
  | { readonly kind: "opaque"; readonly path: string }

export interface BuiltLayer {
  /** Digest of the blob as stored and transferred — what a manifest references. */
  readonly digest: Digest
  /** Digest of the *uncompressed* tar — what `rootfs.diff_ids` references. */
  readonly diffId: Digest
  /** Size of the stored blob, compressed if the layer is compressed. */
  readonly size: number
  /** Size of the uncompressed tar. `docker save` archives need this up front. */
  readonly diffSize: number
  readonly mediaType: string
  readonly blob: Blob
}

/**
 * Reproducibility rules. Two builds of the same content must produce the same digest,
 * so every field a tar header can vary on is pinned to a constant unless explicitly set.
 */
const EPOCH = new Date(0)
const DEFAULT_FILE_MODE = 0o644
const DEFAULT_DIR_MODE = 0o755
const DEFAULT_SYMLINK_MODE = 0o777

/**
 * Normalise a path to its in-layer form: no leading slash, no `.` or empty segments,
 * and no escaping upward. A layer that could write to `../` outside the rootfs is a
 * path-traversal bug, so `..` is rejected outright rather than clamped.
 */
export const normalizeLayerPath = (path: string): string => {
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      throw new Error(`Layer path escapes the root: ${JSON.stringify(path)}`)
    }
    segments.push(segment)
  }
  return segments.join("/")
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

const baseOf = (path: string): string => {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

/** Rewrite whiteout/opaque entries into the real `.wh.` files the OCI spec defines. */
const materializeMarkers = (entry: LayerEntry): LayerEntry => {
  if (entry.kind === "whiteout") {
    const path = normalizeLayerPath(entry.path)
    const parent = parentOf(path)
    const marker = `${parent ? `${parent}/` : ""}.wh.${baseOf(path)}`
    return { kind: "file", path: marker, content: new Uint8Array(0), mode: 0o644 }
  }
  if (entry.kind === "opaque") {
    const path = normalizeLayerPath(entry.path)
    return {
      kind: "file",
      path: `${path ? `${path}/` : ""}.wh..wh..opq`,
      content: new Uint8Array(0),
      mode: 0o644,
    }
  }
  return entry
}

/**
 * Every parent directory of every entry must appear in the tar, or extraction order
 * becomes significant and some runtimes create parents with surprising permissions.
 */
const withImpliedDirectories = (entries: readonly LayerEntry[]): LayerEntry[] => {
  const byPath = new Map<string, LayerEntry>()

  // Explicit entries win, and a later entry for a path supersedes an earlier one.
  for (const entry of entries) {
    const path = normalizeLayerPath(entry.path)
    if (path === "") continue // the layer root is implicit, never an entry
    byPath.set(path, { ...entry, path } as LayerEntry)
  }

  // Fill in ancestors nothing declared explicitly. Walking each path's full chain means
  // an implied directory's own ancestors are covered too, so one pass over a snapshot
  // of the keys is enough.
  for (const path of [...byPath.keys()]) {
    let current = ""
    for (const segment of path.split("/").slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment
      if (!byPath.has(current)) byPath.set(current, { kind: "directory", path: current })
    }
  }

  // Sorting is what makes the output independent of the order entries were discovered in.
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const writeEntry = (pack: ReturnType<typeof tarPack>, entry: LayerEntry): Promise<void> => {
  const mtime = "mtime" in entry ? (entry.mtime ?? EPOCH) : EPOCH
  const uid = "uid" in entry ? (entry.uid ?? 0) : 0
  const gid = "gid" in entry ? (entry.gid ?? 0) : 0
  const common = { name: entry.path, mtime, uid, gid, uname: "", gname: "" }

  switch (entry.kind) {
    case "directory":
      return new Promise((resolve, reject) => {
        pack.entry(
          {
            ...common,
            name: `${entry.path}/`,
            type: "directory",
            mode: entry.mode ?? DEFAULT_DIR_MODE,
          },
          (error) => (error ? reject(error) : resolve()),
        )
      })

    case "symlink":
      return new Promise((resolve, reject) => {
        pack.entry(
          {
            ...common,
            type: "symlink",
            linkname: entry.target,
            mode: entry.mode ?? DEFAULT_SYMLINK_MODE,
          },
          (error) => (error ? reject(error) : resolve()),
        )
      })

    case "file": {
      const mode = entry.mode ?? DEFAULT_FILE_MODE
      if (entry.content instanceof Uint8Array) {
        const content = Buffer.from(entry.content)
        return new Promise((resolve, reject) => {
          pack.entry(
            { ...common, type: "file", mode, size: content.byteLength },
            content,
            (error) => (error ? reject(error) : resolve()),
          )
        })
      }
      const source = entry.content
      const sink = pack.entry({ ...common, type: "file", mode, size: source.size })
      return pipeline(createReadStream(source.file), sink)
    }

    // Markers are rewritten to files before this point.
    case "whiteout":
    case "opaque":
      throw new Error(`Unexpected unmaterialized marker for ${entry.path}`)
  }
}

export interface BuildLayerOptions {
  /** Gzip the layer. Default true — what registries expect. */
  readonly compress?: boolean
}

/**
 * Assemble layer entries into a stored, content-addressed OCI layer.
 *
 * Both digests are computed in a single streaming pass: the uncompressed tar is hashed
 * on its way into gzip (giving the diff ID), and the store hashes the compressed bytes
 * on their way to disk (giving the blob digest). A multi-gigabyte layer never lands in
 * memory.
 */
export const buildLayer = async (
  store: BlobStore,
  entries: readonly LayerEntry[],
  options: BuildLayerOptions = {},
): Promise<BuiltLayer> => {
  const compress = options.compress ?? true
  const prepared = withImpliedDirectories(entries.map(materializeMarkers))

  const pack = tarPack()
  const diffHasher = hashingStream()

  // Entries are written concurrently with the pipeline draining `pack`; awaiting the
  // writes first would deadlock on backpressure once the internal buffer fills.
  const writing = (async () => {
    try {
      for (const entry of prepared) await writeEntry(pack, entry)
      pack.finalize()
    } catch (error) {
      pack.destroy(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  })()

  const tarStream = pack.pipe(diffHasher)
  const source = compress
    ? tarStream.pipe(createGzip({ level: 6 })) // pinned so output does not drift with zlib defaults
    : tarStream

  const [, blob] = await Promise.all([writing, store.put(source)])

  return {
    digest: blob.digest,
    diffId: diffHasher.digest(),
    size: blob.size,
    diffSize: diffHasher.bytesSeen,
    mediaType: compress ? OCI_LAYER_GZIP : OCI_LAYER_TAR,
    blob,
  }
}

/**
 * Store an already-formed layer tar (for example one produced inside a sandbox, or
 * pulled from a registry) without rewriting it, recording both of its digests.
 */
export const storeLayerTar = async (
  store: BlobStore,
  tar: Readable,
  options: BuildLayerOptions = {},
): Promise<BuiltLayer> => {
  const compress = options.compress ?? true
  const diffHasher = hashingStream()
  const passthrough = new PassThrough()

  const feeding = pipeline(tar, diffHasher, passthrough)
  const source = compress ? passthrough.pipe(createGzip({ level: 6 })) : passthrough
  const [, blob] = await Promise.all([feeding, store.put(source)])

  return {
    digest: blob.digest,
    diffId: diffHasher.digest(),
    size: blob.size,
    diffSize: diffHasher.bytesSeen,
    mediaType: compress ? OCI_LAYER_GZIP : OCI_LAYER_TAR,
    blob,
  }
}
