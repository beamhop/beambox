import type { Blob, BlobStore } from "./blob.ts"
import type { Digest } from "./digest.ts"
import type { BuiltLayer } from "./layer.ts"
import { OCI_CONFIG, OCI_MANIFEST } from "./media-types.ts"
import {
  type Descriptor,
  encodeJson,
  type ImageConfig,
  type Manifest,
  type Platform,
} from "./spec.ts"

/**
 * A fully assembled image: config and manifest serialised into the blob store, with
 * every layer already present. This is the value the archive writers and the registry
 * pusher consume, and it is complete enough to reconstruct the image anywhere.
 */
export interface ImageArtifact {
  readonly config: ImageConfig
  readonly configDescriptor: Descriptor
  readonly configBlob: Blob
  readonly manifest: Manifest
  readonly manifestDescriptor: Descriptor
  readonly manifestBlob: Blob
  readonly layers: readonly BuiltLayer[]
  readonly platform: Platform
}

/** The digest that identifies this image — its manifest digest. */
export const imageDigest = (image: ImageArtifact): Digest => image.manifestDescriptor.digest

export const emptyImageConfig = (platform: Platform): ImageConfig => ({
  architecture: platform.architecture,
  os: platform.os,
  ...(platform.variant !== undefined ? { variant: platform.variant } : {}),
  config: {},
  rootfs: { type: "layers", diff_ids: [] },
  history: [],
})

/**
 * Serialise a config and its layers into a manifest and store both.
 *
 * `rootfs.diff_ids` is rewritten from the layers rather than trusted from the incoming
 * config: the layer list is the single source of truth, and a config whose diff IDs
 * disagree with its layers produces an image that fails to unpack.
 */
export const assembleImage = async (
  store: BlobStore,
  input: { config: ImageConfig; layers: readonly BuiltLayer[] },
): Promise<ImageArtifact> => {
  const config: ImageConfig = {
    ...input.config,
    rootfs: { type: "layers", diff_ids: input.layers.map((layer) => layer.diffId) },
  }

  const configBytes = encodeJson(config)
  const configBlob = await store.putBytes(configBytes)
  const configDescriptor: Descriptor = {
    mediaType: OCI_CONFIG,
    digest: configBlob.digest,
    size: configBlob.size,
  }

  const manifest: Manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: configDescriptor,
    layers: input.layers.map((layer) => ({
      mediaType: layer.mediaType,
      digest: layer.digest,
      size: layer.size,
    })),
  }

  const manifestBlob = await store.putBytes(encodeJson(manifest))
  const manifestDescriptor: Descriptor = {
    mediaType: OCI_MANIFEST,
    digest: manifestBlob.digest,
    size: manifestBlob.size,
    platform: {
      architecture: config.architecture,
      os: config.os,
      ...(config.variant !== undefined ? { variant: config.variant } : {}),
    },
  }

  return {
    config,
    configDescriptor,
    configBlob,
    manifest,
    manifestDescriptor,
    manifestBlob,
    layers: input.layers,
    platform: {
      architecture: config.architecture,
      os: config.os,
      ...(config.variant !== undefined ? { variant: config.variant } : {}),
    },
  }
}

/**
 * Reconstruct an image from documents that already exist, preserving their exact bytes.
 *
 * Parsing and re-encoding JSON is not byte-preserving — key order is not guaranteed to
 * survive a round trip through a schema — so an image that came from a registry or an
 * archive must keep its original manifest and config bytes or its digest silently
 * changes. That would break content addressing: pulling an image and pushing it
 * elsewhere unmodified must yield the same digest.
 *
 * Builds that genuinely change the config use `assembleImage` instead, where a new
 * digest is the correct outcome.
 */
export const imageFromDocuments = async (
  store: BlobStore,
  input: {
    manifestBytes: Uint8Array
    manifestMediaType: string
    manifest: Manifest
    configBytes: Uint8Array
    config: ImageConfig
    layers: readonly BuiltLayer[]
  },
): Promise<ImageArtifact> => {
  const [manifestBlob, configBlob] = await Promise.all([
    store.putBytes(input.manifestBytes),
    store.putBytes(input.configBytes),
  ])

  const platform: Platform = {
    architecture: input.config.architecture,
    os: input.config.os,
    ...(input.config.variant !== undefined ? { variant: input.config.variant } : {}),
  }

  return {
    config: input.config,
    configDescriptor: input.manifest.config,
    configBlob,
    manifest: input.manifest,
    manifestDescriptor: {
      mediaType: input.manifestMediaType,
      digest: manifestBlob.digest,
      size: manifestBlob.size,
      platform,
    },
    manifestBlob,
    layers: input.layers,
    platform,
  }
}
