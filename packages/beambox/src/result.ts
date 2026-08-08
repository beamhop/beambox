import {
  type ArchiveFormat,
  type Digest,
  type ImageArtifact,
  parseReference,
  writeArchive,
  writeLayoutDirectory,
} from "@beamhop/oci"
import { type PushOptions, pushImage } from "@beamhop/registry"
import { type LoadedImage, loadIntoMicrosandbox } from "@beamhop/vm-executor"

/**
 * A finished image, plus the four things you can do with one.
 *
 * It is also a plain `ImageArtifact`, so the manifest, config, and layers are all there
 * to inspect directly.
 */
export interface BuiltImage extends ImageArtifact {
  /**
   * Write a tar archive. `docker` (the default) produces a `docker save` archive;
   * `oci` produces an OCI Image Layout archive. `msb load` and `docker load` accept both.
   */
  toArchive(
    path: string,
    options?: { tags?: readonly string[]; format?: ArchiveFormat },
  ): Promise<void>

  /** Write an unpacked OCI Image Layout directory, for skopeo, oras, or crane. */
  toLayoutDirectory(directory: string, options?: { tags?: readonly string[] }): Promise<void>

  /** Push to any OCI registry. Blobs already present are skipped. */
  push(reference: string, options?: PushOptions): Promise<Digest>

  /** Load straight into the local microsandbox image cache — no registry, no Docker. */
  load(options?: { tags?: readonly string[]; format?: ArchiveFormat }): Promise<LoadedImage[]>
}

export const asBuiltImage = (
  artifact: ImageArtifact,
  defaultTags: readonly string[],
): BuiltImage => ({
  ...artifact,

  toArchive: (path, options = {}) =>
    writeArchive(artifact, path, {
      tags: options.tags ?? defaultTags,
      ...(options.format !== undefined ? { format: options.format } : {}),
    }),

  toLayoutDirectory: (directory, options = {}) =>
    writeLayoutDirectory(artifact, directory, { tags: options.tags ?? defaultTags }),

  push: (reference, options = {}) => pushImage(artifact, parseReference(reference), options),

  load: (options = {}) =>
    loadIntoMicrosandbox(artifact, {
      tags: options.tags ?? defaultTags,
      ...(options.format !== undefined ? { format: options.format } : {}),
    }),
})
