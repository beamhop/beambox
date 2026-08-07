import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import {
  type BlobStore,
  type BuiltLayer,
  type Descriptor,
  type Digest,
  hashingStream,
  type ImageArtifact,
  type ImageConfig,
  ImageConfigSchema,
  type ImageReference,
  type Index,
  IndexSchema,
  imageFromDocuments,
  type Manifest,
  ManifestSchema,
  mediaTypes,
  type Platform,
  parseJson,
  referenceSelector,
} from "@beamhop/oci"
import { RegistryClient, type RegistryOptions } from "./client.ts"
import { ForeignLayerError, PlatformNotFoundError } from "./errors.ts"

/** The platform a build targets by default: this machine, running Linux guests. */
export const hostPlatform = (): Platform => ({
  architecture:
    process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch,
  os: "linux",
})

export const platformLabel = (platform: Platform): string =>
  `${platform.os}/${platform.architecture}${platform.variant ? `/${platform.variant}` : ""}`

const matchesPlatform = (candidate: Platform | undefined, wanted: Platform): boolean => {
  if (!candidate) return false
  if (candidate.os !== wanted.os || candidate.architecture !== wanted.architecture) return false
  // A wanted variant must match; an unwanted one is ignored, so `arm64` accepts `arm64/v8`.
  return wanted.variant === undefined || candidate.variant === wanted.variant
}

/** Pick the manifest for `wanted` out of a multi-platform index. */
export const selectManifest = (index: Index, wanted: Platform, reference: string): Descriptor => {
  const candidates = index.manifests.filter(
    (descriptor) => descriptor.artifactType === undefined && !isAttestation(descriptor),
  )

  const match = candidates.find((descriptor) => matchesPlatform(descriptor.platform, wanted))
  if (match) return match

  throw new PlatformNotFoundError(
    reference,
    platformLabel(wanted),
    candidates
      .map((descriptor) => (descriptor.platform ? platformLabel(descriptor.platform) : "unknown"))
      .filter((label) => label !== "unknown/unknown"),
  )
}

/** Buildkit attaches SBOM/provenance manifests to indexes; they are not runnable images. */
const isAttestation = (descriptor: Descriptor): boolean =>
  descriptor.annotations?.["vnd.docker.reference.type"] !== undefined ||
  descriptor.platform?.architecture === "unknown"

/**
 * Determine a layer's uncompressed identity.
 *
 * Registries only tell us the compressed digest, but the image config is keyed on
 * uncompressed diff IDs and `docker save` archives need the uncompressed size. Rather
 * than trust the config's ordering, we recompute from the bytes and cross-check.
 */
const measureLayer = async (
  blob: { stream: () => NodeJS.ReadableStream; size: number },
  mediaType: string,
): Promise<{ diffId: Digest; diffSize: number }> => {
  const hasher = hashingStream()
  const source = blob.stream()
  // We only want the hash and the byte count, so the bytes go straight to a sink.
  const discard = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  await pipeline(
    mediaTypes.isGzipLayer(mediaType) ? source.pipe(createGunzip()) : source,
    hasher,
    discard,
  )
  return { diffId: hasher.digest(), diffSize: hasher.bytesSeen }
}

export interface PullOptions extends RegistryOptions {
  /** Platform to resolve a multi-platform reference to. Defaults to the host. */
  readonly platform?: Platform
  /** Called as each layer is resolved, for progress reporting. */
  readonly onProgress?: (event: {
    layer: Digest
    index: number
    total: number
    cached: boolean
  }) => void
}

export interface PulledImage extends ImageArtifact {
  /** The manifest digest as served by the registry. Equal to `manifestDescriptor.digest`
   * unless the registry served bytes that disagree with their own digest header. */
  readonly sourceDigest: Digest
}

/**
 * Pull an image into a blob store and return it fully assembled.
 *
 * Layers already in the store are not re-downloaded — this is what makes a second build
 * on the same base nearly free. Every downloaded blob is verified against the digest that
 * referenced it before it is committed.
 */
export const pullImage = async (
  store: BlobStore,
  reference: ImageReference,
  options: PullOptions = {},
): Promise<PulledImage> => {
  const client = new RegistryClient(reference.registry, options)
  const platform = options.platform ?? hostPlatform()

  const initial = await client.getManifest(reference.repository, referenceSelector(reference))

  let manifest: Manifest
  let manifestBytes: Uint8Array
  let manifestMediaType: string
  let sourceDigest: Digest

  if (mediaTypes.isIndexType(initial.mediaType)) {
    const index = parseJson(IndexSchema, initial.bytes, `index for ${reference.original}`)
    const descriptor = selectManifest(index, platform, reference.original)
    const resolved = await client.getManifest(reference.repository, descriptor.digest)
    manifest = parseJson(ManifestSchema, resolved.bytes, `manifest for ${reference.original}`)
    manifestBytes = resolved.bytes
    manifestMediaType = resolved.mediaType
    sourceDigest = resolved.digest
  } else {
    manifest = parseJson(ManifestSchema, initial.bytes, `manifest for ${reference.original}`)
    manifestBytes = initial.bytes
    manifestMediaType = initial.mediaType
    sourceDigest = initial.digest
  }

  const configBytes = await (async () => {
    const stream = await client.blobStream(reference.repository, manifest.config.digest)
    const blob = await store.put(stream, { expect: manifest.config.digest })
    return await blob.bytes()
  })()

  const config: ImageConfig = parseJson(
    ImageConfigSchema,
    configBytes,
    `image config for ${reference.original}`,
  )

  const layers: BuiltLayer[] = []
  for (const [index, descriptor] of manifest.layers.entries()) {
    if (mediaTypes.isForeignLayer(descriptor.mediaType)) {
      throw new ForeignLayerError(descriptor.mediaType)
    }

    const cached = await store.has(descriptor.digest)
    const blob = cached
      ? await store.get(descriptor.digest)
      : await store.put(await client.blobStream(reference.repository, descriptor.digest), {
          expect: descriptor.digest,
        })

    options.onProgress?.({ layer: descriptor.digest, index, total: manifest.layers.length, cached })

    const { diffId, diffSize } = await measureLayer(blob, descriptor.mediaType)
    layers.push({
      digest: blob.digest,
      diffId,
      size: blob.size,
      diffSize,
      mediaType: descriptor.mediaType,
      blob,
    })
  }

  const image = await imageFromDocuments(store, {
    manifestBytes,
    manifestMediaType,
    manifest,
    configBytes,
    config,
    layers,
  })
  return { ...image, sourceDigest }
}
