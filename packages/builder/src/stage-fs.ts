import { posix } from "node:path"
import type { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import { type BuiltLayer, type LayerEntry, mediaTypes } from "@beambox/oci"
import { extract } from "tar-stream"
import { CopySourceError } from "./errors.ts"

interface IndexedFile {
  /** Which layer holds this path's current content. */
  readonly layer: number
  readonly type: "file" | "directory" | "symlink"
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly linkname: string
  readonly size: number
}

const WHITEOUT = ".wh."
const OPAQUE = ".wh..wh..opq"

const openLayer = (layer: BuiltLayer): Readable => {
  const stream = layer.blob.stream()
  return mediaTypes.isGzipLayer(layer.mediaType) ? stream.pipe(createGunzip()) : stream
}

/** Read one layer's tar headers, calling `onEntry` for each. Content is skipped. */
const scanLayer = (
  layer: BuiltLayer,
  onEntry: (name: string, header: IndexedFile) => void,
  index: number,
) =>
  new Promise<void>((resolve, reject) => {
    const parser = extract()
    parser.on("entry", (header, stream, next) => {
      const name = header.name.replace(/\/+$/, "")
      onEntry(name, {
        layer: index,
        type:
          header.type === "directory"
            ? "directory"
            : header.type === "symlink"
              ? "symlink"
              : "file",
        mode: header.mode ?? 0o644,
        uid: header.uid ?? 0,
        gid: header.gid ?? 0,
        linkname: header.linkname ?? "",
        size: header.size ?? 0,
      })
      stream.on("end", next)
      stream.resume()
    })
    parser.on("finish", resolve)
    parser.on("error", reject)
    openLayer(layer).on("error", reject).pipe(parser)
  })

/**
 * A read-only view of a finished stage's root filesystem, assembled from its layers.
 *
 * This is what makes `COPY --from=builder` work: the earlier stage exists only as OCI
 * layers, so reading a path out of it means replaying those layers in order and applying
 * the whiteout markers that record deletions — exactly what a runtime's overlay would do
 * at boot, done here on the host instead.
 *
 * Only headers are read while indexing; file content is fetched in a second pass, and
 * only for the paths actually being copied.
 */
export class StageFilesystem {
  private constructor(
    private readonly layers: readonly BuiltLayer[],
    private readonly index: Map<string, IndexedFile>,
  ) {}

  static async open(layers: readonly BuiltLayer[]): Promise<StageFilesystem> {
    const index = new Map<string, IndexedFile>()

    const removeTree = (root: string): void => {
      index.delete(root)
      const prefix = `${root}/`
      for (const key of index.keys()) if (key.startsWith(prefix)) index.delete(key)
    }

    for (const [position, layer] of layers.entries()) {
      await scanLayer(
        layer,
        (name, header) => {
          const base = posix.basename(name)
          const parent = posix.dirname(name) === "." ? "" : posix.dirname(name)

          if (base === OPAQUE) {
            // Everything below this directory from lower layers is hidden.
            for (const key of index.keys()) {
              if (parent === "" || key === parent || key.startsWith(`${parent}/`)) {
                if (key !== parent) index.delete(key)
              }
            }
            return
          }

          if (base.startsWith(WHITEOUT)) {
            removeTree(posix.join(parent, base.slice(WHITEOUT.length)))
            return
          }

          index.set(name, header)
        },
        position,
      )
    }

    return new StageFilesystem(layers, index)
  }

  /** Every path in the stage, in sorted order. */
  paths(): string[] {
    return [...this.index.keys()].sort()
  }

  /**
   * Resolve a `COPY --from` source to layer entries, reading content for matched files.
   *
   * Destination rules match the host-side copy: a directory contributes its contents, and
   * a destination is treated as a directory when it ends in `/` or when several sources
   * are being copied.
   */
  async resolve(
    sources: readonly string[],
    destination: string,
    options: { chown?: { uid: number; gid: number }; chmod?: number } = {},
  ): Promise<LayerEntry[]> {
    const destinationIsDirectory = destination.endsWith("/") || sources.length > 1
    const root = destination.replace(/\/+$/, "")

    /** Selected paths, each with the in-image destination it maps to. */
    const selected = new Map<string, string>()

    for (const source of sources) {
      const clean = source.replace(/^\/+/, "").replace(/\/+$/, "")
      const direct = this.index.get(clean)

      if (direct?.type === "directory") {
        const target = destinationIsDirectory ? posix.join(root, posix.basename(clean)) : root
        selected.set(clean, target)
        const prefix = `${clean}/`
        for (const path of this.index.keys()) {
          if (path.startsWith(prefix))
            selected.set(path, posix.join(target, path.slice(prefix.length)))
        }
        continue
      }

      if (direct) {
        selected.set(clean, destinationIsDirectory ? posix.join(root, posix.basename(clean)) : root)
        continue
      }

      // Fall back to glob matching, which is how `COPY --from=b /out/*.js .` resolves.
      const glob = new Bun.Glob(clean)
      let matched = false
      for (const path of this.index.keys()) {
        if (glob.match(path)) {
          selected.set(path, posix.join(root, posix.basename(path)))
          matched = true
        }
      }
      if (!matched) throw new CopySourceError(source, `was not found in the source stage.`)
    }

    if (selected.size === 0) throw new CopySourceError(sources.join(" "), `matched no files.`)

    // Fetch content one layer at a time so each layer is decompressed at most once.
    const contents = await this.readContents(
      [...selected.keys()].filter((path) => this.index.get(path)?.type === "file"),
    )

    const entries: LayerEntry[] = []
    for (const [path, target] of [...selected].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const header = this.index.get(path)
      if (!header) continue

      const attributes = {
        path: target,
        mode: options.chmod ?? header.mode,
        uid: options.chown?.uid ?? header.uid,
        gid: options.chown?.gid ?? header.gid,
      }

      if (header.type === "directory") entries.push({ kind: "directory", ...attributes })
      else if (header.type === "symlink") {
        entries.push({ kind: "symlink", ...attributes, target: header.linkname })
      } else {
        entries.push({
          kind: "file",
          ...attributes,
          content: contents.get(path) ?? new Uint8Array(0),
        })
      }
    }

    return entries
  }

  private async readContents(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    const byLayer = new Map<number, Set<string>>()
    for (const path of paths) {
      const header = this.index.get(path)
      if (!header) continue
      const bucket = byLayer.get(header.layer) ?? new Set<string>()
      bucket.add(path)
      byLayer.set(header.layer, bucket)
    }

    const contents = new Map<string, Uint8Array>()

    for (const [position, wanted] of byLayer) {
      const layer = this.layers[position]
      if (!layer) continue

      await new Promise<void>((resolve, reject) => {
        const parser = extract()
        parser.on("entry", (header, stream, next) => {
          const name = header.name.replace(/\/+$/, "")
          if (!wanted.has(name)) {
            stream.on("end", next)
            stream.resume()
            return
          }
          const chunks: Uint8Array[] = []
          stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
          stream.on("end", () => {
            contents.set(name, Buffer.concat(chunks))
            next()
          })
          stream.resume()
        })
        parser.on("finish", resolve)
        parser.on("error", reject)
        openLayer(layer).on("error", reject).pipe(parser)
      })
    }

    return contents
  }
}
