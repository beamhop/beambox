import { type Digest, isDigest } from "./digest.ts"
import { InvalidReferenceError } from "./errors.ts"

export const DOCKER_HUB_REGISTRY = "registry-1.docker.io"
export const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"])

/** A parsed image reference, normalised to its fully-qualified form. */
export interface ImageReference {
  /** Registry host, e.g. `ghcr.io` or `registry-1.docker.io`. */
  readonly registry: string
  /** Repository path, e.g. `library/python`. */
  readonly repository: string
  /** Tag, absent when the reference is by digest. */
  readonly tag?: string
  /** Digest, when the reference pins one. */
  readonly digest?: Digest
  /** The reference as written by the user. */
  readonly original: string
}

/**
 * The first path component is a registry host rather than part of the repository if it
 * looks like one: a dot (`ghcr.io`), a port (`localhost:5050`), or literally `localhost`.
 * This is the same heuristic Docker uses, and the reason `alpine/git` means Docker Hub
 * while `alpine.io/git` does not.
 */
const looksLikeRegistry = (candidate: string): boolean =>
  candidate.includes(".") || candidate.includes(":") || candidate === "localhost"

export const parseReference = (reference: string): ImageReference => {
  if (reference.trim() === "") throw new InvalidReferenceError(reference, "reference is empty")

  let rest = reference
  let digest: Digest | undefined
  let tag: string | undefined

  const atIndex = rest.lastIndexOf("@")
  if (atIndex !== -1) {
    const candidate = rest.slice(atIndex + 1)
    if (!isDigest(candidate)) {
      throw new InvalidReferenceError(reference, `${JSON.stringify(candidate)} is not a digest`)
    }
    digest = candidate
    rest = rest.slice(0, atIndex)
  }

  // A colon after the last slash is a tag; before it, it is a registry port.
  const colonIndex = rest.lastIndexOf(":")
  if (colonIndex !== -1 && colonIndex > rest.lastIndexOf("/")) {
    tag = rest.slice(colonIndex + 1)
    rest = rest.slice(0, colonIndex)
    if (tag === "") throw new InvalidReferenceError(reference, "tag is empty")
  }

  const segments = rest.split("/")
  const first = segments[0]
  if (first === undefined || first === "") {
    throw new InvalidReferenceError(reference, "repository is empty")
  }

  let registry: string
  let repository: string
  if (segments.length > 1 && looksLikeRegistry(first)) {
    registry = DOCKER_HUB_ALIASES.has(first) ? DOCKER_HUB_REGISTRY : first
    repository = segments.slice(1).join("/")
  } else {
    registry = DOCKER_HUB_REGISTRY
    // Docker Hub official images live under the implicit `library/` namespace.
    repository = segments.length === 1 ? `library/${first}` : rest
  }

  if (repository === "") throw new InvalidReferenceError(reference, "repository is empty")

  return {
    registry,
    repository,
    ...(tag !== undefined ? { tag } : digest !== undefined ? {} : { tag: "latest" }),
    ...(digest !== undefined ? { digest } : {}),
    original: reference,
  }
}

/** The `<repository>:<tag>` form used by `docker save` archives' `RepoTags`. */
export const toRepoTag = (reference: ImageReference): string | undefined => {
  if (reference.tag === undefined) return undefined
  const isHub = reference.registry === DOCKER_HUB_REGISTRY
  const repository =
    isHub && reference.repository.startsWith("library/")
      ? reference.repository.slice("library/".length)
      : isHub
        ? reference.repository
        : `${reference.registry}/${reference.repository}`
  return `${repository}:${reference.tag}`
}

/** The reference a registry API path uses, either `tag` or `sha256:…`. */
export const referenceSelector = (reference: ImageReference): string =>
  reference.digest ?? reference.tag ?? "latest"
