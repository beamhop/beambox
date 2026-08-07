import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { RegistryAuthError } from "./errors.ts"

export type RegistryAuth =
  | { readonly kind: "anonymous" }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: string }

/** A `WWW-Authenticate: Bearer …` challenge, broken into its parameters. */
export interface BearerChallenge {
  readonly realm: string
  readonly service?: string
  readonly scope?: string
}

/**
 * Parse a bearer challenge. Registries quote values and vary the parameter order and
 * spacing, so this reads key="value" pairs rather than matching a fixed shape.
 */
export const parseChallenge = (header: string | null): BearerChallenge | undefined => {
  if (!header || !/^bearer\s/i.test(header)) return undefined

  const parameters = new Map<string, string>()
  for (const match of header.slice("bearer".length).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    const [, key, value] = match
    if (key !== undefined && value !== undefined) parameters.set(key.toLowerCase(), value)
  }

  const realm = parameters.get("realm")
  if (realm === undefined) return undefined

  const service = parameters.get("service")
  const scope = parameters.get("scope")
  return {
    realm,
    ...(service !== undefined ? { service } : {}),
    ...(scope !== undefined ? { scope } : {}),
  }
}

const TokenResponseSchema = z.looseObject({
  token: z.string().optional(),
  access_token: z.string().optional(),
})

/**
 * Exchange a challenge for a bearer token, presenting basic credentials when we have
 * them. Anonymous pulls work the same way — Docker Hub issues a token to nobody in
 * particular — which is why this runs even without credentials.
 */
export const fetchToken = async (
  challenge: BearerChallenge,
  auth: RegistryAuth,
  registry: string,
  fetchImpl: typeof fetch,
): Promise<string> => {
  const url = new URL(challenge.realm)
  if (challenge.service !== undefined) url.searchParams.set("service", challenge.service)
  if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope)

  const headers: Record<string, string> = {}
  if (auth.kind === "basic") {
    headers["authorization"] = `Basic ${btoa(`${auth.username}:${auth.password}`)}`
  }

  const response = await fetchImpl(url, { headers })
  if (!response.ok) {
    throw new RegistryAuthError(
      registry,
      `token endpoint returned ${response.status} ${response.statusText}`,
    )
  }

  const parsed = TokenResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new RegistryAuthError(registry, "token endpoint returned no token")

  const token = parsed.data.token ?? parsed.data.access_token
  if (token === undefined) throw new RegistryAuthError(registry, "token endpoint returned no token")
  return token
}

const DockerConfigSchema = z.looseObject({
  auths: z
    .record(
      z.string(),
      z.looseObject({
        auth: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
    )
    .optional(),
})

/** Docker's config keys Hub under this legacy URL rather than a bare hostname. */
const HUB_CONFIG_KEYS = [
  "https://index.docker.io/v1/",
  "index.docker.io",
  "docker.io",
  "registry-1.docker.io",
]

const candidateKeys = (registry: string): string[] =>
  registry === "registry-1.docker.io" ? HUB_CONFIG_KEYS : [registry, `https://${registry}`]

/**
 * Read credentials from `~/.docker/config.json`.
 *
 * beambox does not require Docker, but if a user has already logged in with some tool
 * that wrote this file, honouring it saves them configuring the same registry twice.
 * Credential *helpers* are not consulted — only credentials stored inline.
 */
export const loadDockerCredentials = async (
  registry: string,
  configPath = join(homedir(), ".docker", "config.json"),
): Promise<RegistryAuth | undefined> => {
  const file = Bun.file(configPath)
  if (!(await file.exists())) return undefined

  const parsed = DockerConfigSchema.safeParse(await file.json().catch(() => undefined))
  if (!parsed.success || !parsed.data.auths) return undefined

  for (const key of candidateKeys(registry)) {
    const entry = parsed.data.auths[key]
    if (!entry) continue

    if (entry.username !== undefined && entry.password !== undefined) {
      return { kind: "basic", username: entry.username, password: entry.password }
    }
    if (entry.auth !== undefined && entry.auth !== "") {
      const decoded = Buffer.from(entry.auth, "base64").toString("utf8")
      const separator = decoded.indexOf(":")
      if (separator > 0) {
        return {
          kind: "basic",
          username: decoded.slice(0, separator),
          password: decoded.slice(separator + 1),
        }
      }
    }
  }
  return undefined
}
