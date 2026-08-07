import type { Digest, ImageArtifact, ImageReference } from "@beamhop/oci"
import { referenceSelector } from "@beamhop/oci"
import { RegistryClient, type RegistryOptions } from "./client.ts"

export interface PushOptions extends RegistryOptions {
  readonly onProgress?: (event: {
    readonly what: "config" | "layer" | "manifest"
    readonly digest: Digest
    readonly index?: number
    readonly total?: number
    readonly skipped: boolean
  }) => void
}

/**
 * Push an assembled image to a registry.
 *
 * Blobs go up before the manifest that references them, which is what the distribution
 * spec requires: a manifest naming a blob the registry does not hold is rejected. Blobs
 * the registry already has are skipped after a cheap HEAD, so re-pushing an image whose
 * base layers are already there only transfers what actually changed.
 */
export const pushImage = async (
  image: ImageArtifact,
  reference: ImageReference,
  options: PushOptions = {},
): Promise<Digest> => {
  const client = new RegistryClient(reference.registry, options)
  const repository = reference.repository

  for (const [index, layer] of image.layers.entries()) {
    const result = await client.putBlob(repository, layer.digest, layer.size, () =>
      layer.blob.stream(),
    )
    options.onProgress?.({
      what: "layer",
      digest: layer.digest,
      index,
      total: image.layers.length,
      skipped: !result.uploaded,
    })
  }

  const config = await client.putBlob(
    repository,
    image.configDescriptor.digest,
    image.configBlob.size,
    () => image.configBlob.stream(),
  )
  options.onProgress?.({
    what: "config",
    digest: image.configDescriptor.digest,
    skipped: !config.uploaded,
  })

  const digest = await client.putManifest(
    repository,
    referenceSelector(reference),
    image.manifestDescriptor.mediaType,
    await image.manifestBlob.bytes(),
  )
  options.onProgress?.({ what: "manifest", digest, skipped: false })

  return digest
}
