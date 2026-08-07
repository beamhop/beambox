/** OCI and Docker media types, and the mapping between the two dialects. */

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json"
export const OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
export const OCI_LAYER_TAR = "application/vnd.oci.image.layer.v1.tar"
export const OCI_LAYER_GZIP = "application/vnd.oci.image.layer.v1.tar+gzip"
export const OCI_EMPTY = "application/vnd.oci.empty.v1+json"

export const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
export const DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
export const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json"
export const DOCKER_LAYER_GZIP = "application/vnd.docker.image.rootfs.diff.tar.gzip"
export const DOCKER_FOREIGN_LAYER = "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip"

/** Media types that identify a single-platform image manifest. */
export const MANIFEST_TYPES: readonly string[] = [OCI_MANIFEST, DOCKER_MANIFEST]

/** Media types that identify a multi-platform index. */
export const INDEX_TYPES: readonly string[] = [OCI_INDEX, DOCKER_MANIFEST_LIST]

/** Everything we are willing to receive from a registry, in preference order. */
export const ACCEPT_HEADER = [OCI_INDEX, OCI_MANIFEST, DOCKER_MANIFEST_LIST, DOCKER_MANIFEST].join(
  ", ",
)

export const isIndexType = (mediaType: string): boolean => INDEX_TYPES.includes(mediaType)
export const isManifestType = (mediaType: string): boolean => MANIFEST_TYPES.includes(mediaType)

/**
 * Foreign (a.k.a. non-distributable) layers are hosted outside the registry. We refuse
 * them rather than silently producing an image whose layers cannot be fetched.
 */
export const isForeignLayer = (mediaType: string): boolean =>
  mediaType === DOCKER_FOREIGN_LAYER ||
  mediaType === "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"

/** True when a layer blob is gzip-compressed and must be inflated to reach the tar. */
export const isGzipLayer = (mediaType: string): boolean =>
  mediaType === OCI_LAYER_GZIP || mediaType === DOCKER_LAYER_GZIP || mediaType.endsWith("+gzip")
