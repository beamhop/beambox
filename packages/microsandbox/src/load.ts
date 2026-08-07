import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArchiveFormat, type ImageArtifact, writeArchive } from "@beambox/oci"

export interface LoadOptions {
  /** Tags to give the image in the microsandbox cache. */
  readonly tags?: readonly string[]
  /**
   * Archive form used for the handoff. `oci` (the default) keeps layers compressed and
   * is therefore cheaper to write; both are accepted by `msb load`.
   */
  readonly format?: ArchiveFormat
}

export interface LoadedImage {
  readonly reference: string
  readonly manifestDigest: string | null
  readonly layerCount: number
}

/**
 * Load a built image straight into microsandbox's local cache.
 *
 * This is the handoff the whole project exists for: the image goes from beambox to a
 * runnable microVM without a registry, a daemon, or Docker anywhere in the path. The
 * archive is written to a temporary file, imported, and deleted.
 */
export const loadIntoMicrosandbox = async (
  image: ImageArtifact,
  options: LoadOptions = {},
): Promise<LoadedImage[]> => {
  const { Image } = await import("microsandbox")

  const directory = await mkdtemp(join(tmpdir(), "beambox-load-"))
  const format = options.format ?? "oci"
  const archive = join(directory, `image.${format}.tar`)

  try {
    const tags = options.tags ?? []
    await writeArchive(image, archive, { format, ...(tags.length > 0 ? { tags } : {}) })

    const first = tags[0]
    const handles = await Image.load(archive, ...(first !== undefined ? [{ tag: first }] : []))

    return handles.map((handle) => ({
      reference: handle.reference,
      manifestDigest: handle.manifestDigest,
      layerCount: handle.layerCount,
    }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
