/**
 * A real, conformant-enough OCI Distribution v2 registry, in process.
 *
 * This is deliberately not a mock: it stores blobs, enforces digests, issues bearer
 * tokens, and rejects manifests whose blobs are missing — so the client is exercised
 * against actual protocol behaviour rather than against our assumptions about it.
 */
export interface TestRegistry {
  readonly host: string
  readonly server: ReturnType<typeof Bun.serve>
  readonly blobs: Map<string, Uint8Array>
  readonly manifests: Map<string, { bytes: Uint8Array; mediaType: string }>
  /** Requests seen, for asserting things like "the layer was not re-uploaded". */
  readonly requests: { method: string; path: string }[]
  stop(): void
}

export interface TestRegistryOptions {
  /** Demand a bearer token, exercising the challenge/token exchange. */
  readonly requireAuth?: boolean
  /** Credentials the token endpoint will accept. */
  readonly credentials?: { username: string; password: string }
}

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`

export const startTestRegistry = (options: TestRegistryOptions = {}): TestRegistry => {
  const blobs = new Map<string, Uint8Array>()
  const manifests = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  const uploads = new Map<string, string>()
  const requests: { method: string; path: string }[] = []
  const TOKEN = "test-token-value"

  const unauthorized = (scope: string, host: string): Response =>
    new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }), {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="http://${host}/token",service="test-registry",scope="${scope}"`,
      },
    })

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      const host = url.host
      requests.push({ method: request.method, path })

      // Token endpoint. Verifies basic credentials when the registry demands them.
      if (path === "/token") {
        if (options.credentials) {
          const header = request.headers.get("authorization") ?? ""
          const expected = `Basic ${btoa(`${options.credentials.username}:${options.credentials.password}`)}`
          if (header !== expected) return new Response("bad credentials", { status: 401 })
        }
        return Response.json({ token: TOKEN })
      }

      if (options.requireAuth && request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return unauthorized(url.searchParams.get("scope") ?? "repository:test:pull", host)
      }

      if (path === "/v2/" || path === "/v2") return new Response("{}", { status: 200 })

      // Blob upload session.
      const uploadStart = path.match(/^\/v2\/(.+)\/blobs\/uploads\/$/)
      if (uploadStart && request.method === "POST") {
        const id = crypto.randomUUID()
        uploads.set(id, uploadStart[1] ?? "")
        return new Response(null, {
          status: 202,
          headers: { location: `/v2/upload/${id}`, "docker-upload-uuid": id },
        })
      }

      const uploadFinish = path.match(/^\/v2\/upload\/([^/]+)$/)
      if (uploadFinish && request.method === "PUT") {
        const id = uploadFinish[1] ?? ""
        if (!uploads.has(id)) return new Response("no such upload", { status: 404 })

        const digest = url.searchParams.get("digest")
        const body = new Uint8Array(await request.arrayBuffer())
        if (digest === null) return new Response("missing digest", { status: 400 })
        if (sha256(body) !== digest) {
          return new Response(`digest mismatch: got ${sha256(body)} want ${digest}`, {
            status: 400,
          })
        }

        blobs.set(digest, body)
        uploads.delete(id)
        return new Response(null, { status: 201, headers: { "docker-content-digest": digest } })
      }

      // Blob fetch.
      const blob = path.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/)
      if (blob) {
        const bytes = blobs.get(blob[2] ?? "")
        if (!bytes) return new Response("not found", { status: 404 })
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(bytes.byteLength) },
          })
        }
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "docker-content-digest": blob[2] ?? "",
          },
        })
      }

      // Manifests.
      const manifest = path.match(/^\/v2\/(.+)\/manifests\/(.+)$/)
      if (manifest) {
        const [, repository = "", selector = ""] = manifest

        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer())
          const mediaType = request.headers.get("content-type") ?? "application/json"
          const digest = sha256(bytes)

          // A conformant registry refuses a manifest whose blobs it does not hold.
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
            config?: { digest?: string }
            layers?: { digest?: string }[]
          }
          const referenced = [parsed.config?.digest, ...(parsed.layers ?? []).map((l) => l.digest)]
          for (const reference of referenced) {
            if (reference !== undefined && !blobs.has(reference)) {
              return new Response(`BLOB_UNKNOWN: ${reference}`, { status: 400 })
            }
          }

          manifests.set(`${repository}:${selector}`, { bytes, mediaType })
          manifests.set(`${repository}:${digest}`, { bytes, mediaType })
          return new Response(null, { status: 201, headers: { "docker-content-digest": digest } })
        }

        const found = manifests.get(`${repository}:${selector}`)
        if (!found) return new Response("not found", { status: 404 })
        return new Response(found.bytes, {
          headers: {
            "content-type": found.mediaType,
            "docker-content-digest": sha256(found.bytes),
          },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })

  return {
    host: `localhost:${server.port}`,
    server,
    blobs,
    manifests,
    requests,
    stop: () => server.stop(true),
  }
}
