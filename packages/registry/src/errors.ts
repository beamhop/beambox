import { BeamboxError } from "@beamhop/oci"

/** The registry rejected our credentials, or demanded some we do not have. */
export class RegistryAuthError extends BeamboxError {
  readonly code = "REGISTRY_AUTH"

  constructor(
    readonly registry: string,
    detail: string,
  ) {
    super(`Authentication failed for ${registry}: ${detail}`)
  }
}

/** The registry returned a response we cannot proceed from. */
export class RegistryRequestError extends BeamboxError {
  readonly code = "REGISTRY_REQUEST"

  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Registry request failed: ${status} for ${url}${body ? `\n${body.slice(0, 500)}` : ""}`)
  }
}

/** The requested image exists but not for the platform we need. */
export class PlatformNotFoundError extends BeamboxError {
  readonly code = "PLATFORM_NOT_FOUND"

  constructor(
    readonly reference: string,
    readonly wanted: string,
    readonly available: readonly string[],
  ) {
    super(
      `${reference} has no ${wanted} manifest. Available: ${available.join(", ") || "(none listed)"}`,
    )
  }
}

/** The image relies on layers hosted outside the registry, which we refuse to fake. */
export class ForeignLayerError extends BeamboxError {
  readonly code = "FOREIGN_LAYER"

  constructor(readonly mediaType: string) {
    super(
      `Image contains a non-distributable layer (${mediaType}). beambox cannot rebuild it, and an ` +
        `image missing its layers would fail at run time rather than here.`,
    )
  }
}
