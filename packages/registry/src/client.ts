import { readFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { type Digest, mediaTypes } from "@beambox/oci"
import { fetchToken, loadDockerCredentials, parseChallenge, type RegistryAuth } from "./auth.ts"
import { RegistryAuthError, RegistryRequestError } from "./errors.ts"

export interface RegistryOptions {
  /** Explicit credentials. Takes precedence over anything on disk. */
  readonly auth?: RegistryAuth
  /** Talk plain HTTP instead of HTTPS — for local registries without TLS. */
  readonly insecure?: boolean
  /** Path to a PEM bundle of extra CA roots, for registries behind an internal CA. */
  readonly caCerts?: string
  /** Fall back to `~/.docker/config.json` when no explicit auth is given. Default true. */
  readonly useDockerCredentials?: boolean
  /** Injection point for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch
}

export interface ManifestResponse {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly digest: Digest
}

/**
 * A client for one registry host, speaking the OCI Distribution v2 API.
 *
 * Auth is handled lazily and per-scope: a request goes out unauthenticated, and only if
 * the registry answers with a challenge do we exchange it for a token. Tokens are cached
 * by scope, so pulling twenty layers from one repository costs one token exchange.
 */
export class RegistryClient {
  private readonly tokens = new Map<string, string>()
  private readonly fetchImpl: typeof fetch
  private auth: RegistryAuth | undefined
  private authResolved = false
  private caCertificate: Buffer | undefined
  private caLoaded = false

  constructor(
    readonly registry: string,
    private readonly options: RegistryOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.auth = options.auth
    this.authResolved = options.auth !== undefined
  }

  private get baseUrl(): string {
    return `${this.options.insecure ? "http" : "https"}://${this.registry}`
  }

  private async credentials(): Promise<RegistryAuth> {
    if (!this.authResolved) {
      this.auth =
        this.options.useDockerCredentials === false
          ? undefined
          : await loadDockerCredentials(this.registry)
      this.authResolved = true
    }
    return this.auth ?? { kind: "anonymous" }
  }

  /** Bun accepts a `tls` option on fetch; without a custom CA we leave defaults alone. */
  private async transportOptions(): Promise<RequestInit> {
    if (this.options.caCerts === undefined) return {}
    if (!this.caLoaded) {
      this.caCertificate = await readFile(this.options.caCerts)
      this.caLoaded = true
    }
    return { tls: { ca: this.caCertificate } } as RequestInit
  }

  /**
   * Perform a request, transparently acquiring a token if the registry demands one.
   *
   * `scope` keys the token cache. A caller that will push must ask for a push scope up
   * front, because registries issue narrow tokens and will not widen one after the fact.
   */
  async request(path: string, scope: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`
    const transport = await this.transportOptions()

    const send = async (token: string | undefined): Promise<Response> => {
      const headers = new Headers(init.headers)
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`)
      else {
        const auth = await this.credentials()
        if (auth.kind === "basic") {
          headers.set("authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`)
        } else if (auth.kind === "bearer") {
          headers.set("authorization", `Bearer ${auth.token}`)
        }
      }
      return await this.fetchImpl(url, { ...transport, ...init, headers })
    }

    const cached = this.tokens.get(scope)
    let response = await send(cached)

    if (response.status === 401 && cached === undefined) {
      const challenge = parseChallenge(response.headers.get("www-authenticate"))
      if (challenge) {
        const token = await fetchToken(
          { ...challenge, scope },
          await this.credentials(),
          this.registry,
          this.fetchImpl,
        )
        this.tokens.set(scope, token)
        response = await send(token)
      }
    }

    if (response.status === 401 || response.status === 403) {
      const auth = await this.credentials()
      throw new RegistryAuthError(
        this.registry,
        auth.kind === "anonymous"
          ? `${response.status} for ${path}. No credentials were available; log in or pass auth.`
          : `${response.status} for ${path} with ${auth.kind} credentials.`,
      )
    }

    return response
  }

  static pullScope(repository: string): string {
    return `repository:${repository}:pull`
  }

  static pushScope(repository: string): string {
    return `repository:${repository}:pull,push`
  }

  /** Fetch a manifest or index by tag or digest. */
  async getManifest(repository: string, selector: string): Promise<ManifestResponse> {
    const path = `/v2/${repository}/manifests/${selector}`
    const response = await this.request(path, RegistryClient.pullScope(repository), {
      headers: { accept: mediaTypes.ACCEPT_HEADER },
    })

    if (!response.ok) {
      throw new RegistryRequestError(response.status, path, await response.text().catch(() => ""))
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? mediaTypes.OCI_MANIFEST
    const headerDigest = response.headers.get("docker-content-digest")

    // Prefer the registry's digest header, but never trust it blindly: recompute when
    // absent so a manifest is always addressed by content we actually verified.
    const digest =
      headerDigest !== null && /^sha256:[0-9a-f]{64}$/.test(headerDigest)
        ? (headerDigest as Digest)
        : (`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` as Digest)

    return { bytes, mediaType, digest }
  }

  async blobExists(repository: string, digest: Digest): Promise<boolean> {
    const response = await this.request(
      `/v2/${repository}/blobs/${digest}`,
      RegistryClient.pushScope(repository),
      { method: "HEAD" },
    )
    return response.ok
  }

  /** Open a blob for streaming. The caller is responsible for verifying its digest. */
  async blobStream(repository: string, digest: Digest): Promise<Readable> {
    const path = `/v2/${repository}/blobs/${digest}`
    const response = await this.request(path, RegistryClient.pullScope(repository))

    if (!response.ok || response.body === null) {
      throw new RegistryRequestError(response.status, path, await response.text().catch(() => ""))
    }
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  }

  /**
   * Upload a blob, skipping the transfer entirely when the registry already has it.
   *
   * Uses the two-step upload (POST for a session, then a single PUT carrying the bytes),
   * which every conformant registry supports and which avoids the chunk-size negotiation
   * that PATCH-based uploads require.
   */
  async putBlob(
    repository: string,
    digest: Digest,
    size: number,
    open: () => Readable,
  ): Promise<{ uploaded: boolean }> {
    if (await this.blobExists(repository, digest)) return { uploaded: false }

    const scope = RegistryClient.pushScope(repository)
    const start = await this.request(`/v2/${repository}/blobs/uploads/`, scope, { method: "POST" })

    if (start.status !== 202) {
      throw new RegistryRequestError(
        start.status,
        `/v2/${repository}/blobs/uploads/`,
        await start.text().catch(() => ""),
      )
    }

    const location = start.headers.get("location")
    if (location === null) {
      throw new RegistryRequestError(start.status, "blob upload", "registry returned no Location")
    }

    const target = new URL(location, this.baseUrl)
    target.searchParams.set("digest", digest)

    const response = await this.request(target.toString(), scope, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      body: Readable.toWeb(open()) as Bun.BodyInit,
      // Node and Bun both require this to stream a request body rather than buffer it.
      duplex: "half",
    } as RequestInit)

    if (!response.ok) {
      throw new RegistryRequestError(
        response.status,
        target.toString(),
        await response.text().catch(() => ""),
      )
    }
    return { uploaded: true }
  }

  async putManifest(
    repository: string,
    selector: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<Digest> {
    const path = `/v2/${repository}/manifests/${selector}`
    const response = await this.request(path, RegistryClient.pushScope(repository), {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: bytes,
    })

    if (!response.ok) {
      throw new RegistryRequestError(response.status, path, await response.text().catch(() => ""))
    }

    const digest = response.headers.get("docker-content-digest")
    return digest !== null && /^sha256:[0-9a-f]{64}$/.test(digest)
      ? (digest as Digest)
      : (`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` as Digest)
  }
}
