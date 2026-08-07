import { createWriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import { pack as tarPack } from "tar-stream"
import { digestHex } from "./digest.ts"
import type { ImageArtifact } from "./image.ts"
import type { BuiltLayer } from "./layer.ts"
import { isGzipLayer, OCI_INDEX } from "./media-types.ts"
import { type Descriptor, encodeJson, type Index } from "./spec.ts"

export type ArchiveFormat = "docker" | "oci"

export interface WriteArchiveOptions {
  /** Tags recorded in the archive, e.g. `["app:local"]`. */
  readonly tags?: readonly string[]
  readonly format?: ArchiveFormat
}

/** Deterministic tar headers, matching the layer writer's rules. */
const ARCHIVE_HEADER = { mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "", mode: 0o644 }

const addBytes = (
  pack: ReturnType<typeof tarPack>,
  name: string,
  data: Uint8Array,
): Promise<void> =>
  new Promise((resolve, reject) => {
    pack.entry({ ...ARCHIVE_HEADER, name, size: data.byteLength }, Buffer.from(data), (error) =>
      error ? reject(error) : resolve(),
    )
  })

const addStream = (
  pack: ReturnType<typeof tarPack>,
  name: string,
  size: number,
  source: Readable,
): Promise<void> => pipeline(source, pack.entry({ ...ARCHIVE_HEADER, name, size }))

const addDirectory = (pack: ReturnType<typeof tarPack>, name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    pack.entry({ ...ARCHIVE_HEADER, name, type: "directory", mode: 0o755 }, (error) =>
      error ? reject(error) : resolve(),
    )
  })

/**
 * A layer as raw, uncompressed tar bytes. `docker save` archives store layers
 * uncompressed, so a gzip layer is inflated on the way into the archive.
 */
const uncompressedLayer = (layer: BuiltLayer): Readable =>
  isGzipLayer(layer.mediaType) ? layer.blob.stream().pipe(createGunzip()) : layer.blob.stream()

/**
 * Write a `docker save`-compatible archive.
 *
 * Layer directories are named by diff ID, config by its own digest — the same convention
 * `msb save` uses, so the two are interchangeable. Accepted by `msb load`, `docker load`,
 * `podman load`, and `skopeo`.
 */
const writeDockerArchive = async (
  image: ImageArtifact,
  output: string,
  tags: readonly string[],
): Promise<void> => {
  const pack = tarPack()
  const done = pipeline(pack, createWriteStream(output))

  const configName = `${digestHex(image.configDescriptor.digest)}.json`
  const layerPaths = image.layers.map((layer) => `${digestHex(layer.diffId)}/layer.tar`)

  const writing = (async () => {
    try {
      await addBytes(
        pack,
        "manifest.json",
        encodeJson([
          {
            Config: configName,
            RepoTags: tags.length > 0 ? tags : null,
            Layers: layerPaths,
          },
        ]),
      )
      await addBytes(pack, configName, await image.configBlob.bytes())

      for (const layer of image.layers) {
        const id = digestHex(layer.diffId)
        await addBytes(pack, `${id}/VERSION`, new TextEncoder().encode("1.0"))
        await addBytes(pack, `${id}/json`, new TextEncoder().encode("{}"))
        await addStream(pack, `${id}/layer.tar`, layer.diffSize, uncompressedLayer(layer))
      }
      pack.finalize()
    } catch (error) {
      pack.destroy(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  })()

  await Promise.all([writing, done])
}

/** The `index.json` for an OCI layout, tagging the manifest with each requested name. */
const buildIndex = (image: ImageArtifact, tags: readonly string[]): Index => {
  const manifests: Descriptor[] =
    tags.length === 0
      ? [image.manifestDescriptor]
      : tags.map((tag) => ({
          ...image.manifestDescriptor,
          annotations: { "org.opencontainers.image.ref.name": tag },
        }))
  return { schemaVersion: 2, mediaType: OCI_INDEX, manifests }
}

/** Every blob an OCI layout must contain, keyed by its `blobs/sha256/<hex>` path. */
const layoutBlobs = (
  image: ImageArtifact,
): { path: string; size: number; open: () => Readable }[] => [
  {
    path: `blobs/sha256/${digestHex(image.manifestDescriptor.digest)}`,
    size: image.manifestBlob.size,
    open: () => image.manifestBlob.stream(),
  },
  {
    path: `blobs/sha256/${digestHex(image.configDescriptor.digest)}`,
    size: image.configBlob.size,
    open: () => image.configBlob.stream(),
  },
  ...image.layers.map((layer) => ({
    path: `blobs/sha256/${digestHex(layer.digest)}`,
    size: layer.size,
    open: () => layer.blob.stream(),
  })),
]

/** Write an OCI Image Layout archive. Layers keep whatever compression they already have. */
const writeOciArchive = async (
  image: ImageArtifact,
  output: string,
  tags: readonly string[],
): Promise<void> => {
  const pack = tarPack()
  const done = pipeline(pack, createWriteStream(output))

  const writing = (async () => {
    try {
      await addBytes(pack, "oci-layout", encodeJson({ imageLayoutVersion: "1.0.0" }))
      await addBytes(pack, "index.json", encodeJson(buildIndex(image, tags)))
      await addDirectory(pack, "blobs")
      await addDirectory(pack, "blobs/sha256")
      for (const blob of layoutBlobs(image)) {
        await addStream(pack, blob.path, blob.size, blob.open())
      }
      pack.finalize()
    } catch (error) {
      pack.destroy(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  })()

  await Promise.all([writing, done])
}

/**
 * Write an image to a tar archive that `msb load` accepts.
 *
 * `docker` (the default) produces a `docker save` archive; `oci` produces an OCI Image
 * Layout archive. Both are loadable by microsandbox; the OCI form additionally preserves
 * layer compression, so it is the cheaper one to produce.
 */
export const writeArchive = async (
  image: ImageArtifact,
  output: string,
  options: WriteArchiveOptions = {},
): Promise<void> => {
  await mkdir(dirname(output), { recursive: true })
  const tags = options.tags ?? []
  if ((options.format ?? "docker") === "oci") {
    await writeOciArchive(image, output, tags)
  } else {
    await writeDockerArchive(image, output, tags)
  }
}

/**
 * Write an unpacked OCI Image Layout directory.
 *
 * Useful for inspection, for caching between CI steps, and as input to `skopeo`, `oras`,
 * and `crane`, which all read layout directories directly.
 */
export const writeLayoutDirectory = async (
  image: ImageArtifact,
  directory: string,
  options: { tags?: readonly string[] } = {},
): Promise<void> => {
  await mkdir(join(directory, "blobs", "sha256"), { recursive: true })
  await writeFile(join(directory, "oci-layout"), encodeJson({ imageLayoutVersion: "1.0.0" }))
  await writeFile(join(directory, "index.json"), encodeJson(buildIndex(image, options.tags ?? [])))

  for (const blob of layoutBlobs(image)) {
    await pipeline(blob.open(), createWriteStream(join(directory, blob.path)))
  }
}
