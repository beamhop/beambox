import { chmod, mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import type { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import { ExecutorError } from "@beamhop/builder"
import { BlobStore, type BuiltLayer, mediaTypes, type Platform, parseReference } from "@beamhop/oci"
import { pullImage } from "@beamhop/registry"
import { extract } from "tar-stream"

/**
 * The image beambox borrows its guest-side toolchain from.
 *
 * `busybox:musl` is statically linked, so the binary runs in any guest regardless of what
 * libc — if any — the base image ships. That is what lets `RUN` work on `scratch` and on
 * distroless images, which have no shell, no `tar`, and no `find` of their own.
 */
const BUSYBOX_IMAGE = "busybox:musl"
const BUSYBOX_PATH = "bin/busybox"

const normalize = (name: string): string => name.replace(/^\.?\/+/, "").replace(/\/+$/, "")

/**
 * Fetch a static busybox for `platform` and cache it on the host.
 *
 * It is pulled through beambox's own registry client, so this needs neither Docker nor
 * any extra download infrastructure: the tool that builds images also fetches its own
 * bootstrap binary.
 */
export const ensureBusybox = async (
  cacheDir: string,
  platform: Platform,
  options: { store?: BlobStore } = {},
): Promise<string> => {
  const target = join(cacheDir, "busybox", `${platform.os}-${platform.architecture}`, "busybox")
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  )
    return target

  const store = options.store ?? new BlobStore(join(cacheDir, "blobs"))
  const image = await pullImage(store, parseReference(BUSYBOX_IMAGE), { platform })

  // Walk layers top-down: the highest layer holding the binary is the effective one.
  for (const layer of [...image.layers].reverse()) {
    const binary = await readBusybox(layer)
    if (binary) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, binary)
      await chmod(target, 0o755)
      return target
    }
  }

  throw new ExecutorError(
    `Could not find ${BUSYBOX_PATH} in ${BUSYBOX_IMAGE} for ${platform.os}/${platform.architecture}.`,
  )
}

const openLayer = (layer: BuiltLayer): Readable => {
  const stream = layer.blob.stream()
  return mediaTypes.isGzipLayer(layer.mediaType) ? stream.pipe(createGunzip()) : stream
}

const scan = (
  layer: BuiltLayer,
  onEntry: (name: string, header: { type: string; linkname: string }, stream: Readable) => boolean,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const parser = extract()
    parser.on("entry", (header, stream, next) => {
      const wants = onEntry(
        normalize(header.name),
        { type: String(header.type), linkname: header.linkname ?? "" },
        stream as unknown as Readable,
      )
      if (!wants) {
        stream.on("end", next)
        stream.resume()
        return
      }
      stream.on("end", next)
    })
    parser.on("finish", resolve)
    parser.on("error", reject)
    const input = openLayer(layer)
    input.on("error", reject)
    input.pipe(parser)
  })

/**
 * Read the busybox binary out of a layer.
 *
 * Busybox images store every applet as a hardlink to one real file, and tar records only
 * the *first* of a hardlink set as a regular file. Since `bin/[` sorts before
 * `bin/busybox`, the real bytes usually live under an applet name and `bin/busybox` is
 * only a link to it — so the link has to be followed rather than read directly.
 */
const readBusybox = async (layer: BuiltLayer): Promise<Uint8Array | undefined> => {
  const links = new Map<string, string>()
  let seen = false

  await scan(layer, (name, header) => {
    if (header.type === "link") links.set(name, normalize(posix.resolve("/", header.linkname)))
    if (name === BUSYBOX_PATH) seen = true
    return false
  })

  if (!seen) return undefined

  // Follow the hardlink chain to the path that actually carries the bytes.
  let realPath = BUSYBOX_PATH
  const visited = new Set<string>()
  while (links.has(realPath) && !visited.has(realPath)) {
    visited.add(realPath)
    realPath = links.get(realPath) ?? realPath
  }

  let content: Uint8Array | undefined
  await scan(layer, (name, header, stream) => {
    if (name !== realPath || header.type === "link") return false
    const chunks: Uint8Array[] = []
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    stream.on("end", () => {
      content = Buffer.concat(chunks)
    })
    stream.resume()
    return true
  })

  return content
}
