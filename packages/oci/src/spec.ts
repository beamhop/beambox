import { z } from "zod"
import type { Digest } from "./digest.ts"
import { ManifestError } from "./errors.ts"

/**
 * Schemas for the OCI image-spec documents. Everything crossing a trust boundary
 * (registry responses, archives on disk) is parsed through these rather than cast.
 *
 * Read schemas are lenient about unknown keys — real registries add their own — but
 * strict about the fields we depend on.
 */

const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex chars>")
  .transform((value) => value as Digest)

export const PlatformSchema = z.looseObject({
  architecture: z.string(),
  os: z.string(),
  "os.version": z.string().optional(),
  "os.features": z.array(z.string()).optional(),
  variant: z.string().optional(),
})
export type Platform = z.infer<typeof PlatformSchema>

export const DescriptorSchema = z.looseObject({
  mediaType: z.string(),
  digest: digestSchema,
  size: z.number().int().nonnegative(),
  urls: z.array(z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  platform: PlatformSchema.optional(),
  artifactType: z.string().optional(),
})
export type Descriptor = z.infer<typeof DescriptorSchema>

export const ManifestSchema = z.looseObject({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  artifactType: z.string().optional(),
  config: DescriptorSchema,
  layers: z.array(DescriptorSchema),
  subject: DescriptorSchema.optional(),
  annotations: z.record(z.string(), z.string()).optional(),
})
export type Manifest = z.infer<typeof ManifestSchema>

export const IndexSchema = z.looseObject({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  manifests: z.array(DescriptorSchema),
  subject: DescriptorSchema.optional(),
  annotations: z.record(z.string(), z.string()).optional(),
})
export type Index = z.infer<typeof IndexSchema>

/** The `config` block of an image config — what a runtime uses to launch the container. */
export const ImageConfigBlockSchema = z.looseObject({
  User: z.string().optional(),
  ExposedPorts: z.record(z.string(), z.object({})).optional(),
  Env: z.array(z.string()).optional(),
  Entrypoint: z.array(z.string()).nullable().optional(),
  Cmd: z.array(z.string()).nullable().optional(),
  Volumes: z.record(z.string(), z.object({})).nullable().optional(),
  WorkingDir: z.string().optional(),
  Labels: z.record(z.string(), z.string()).nullable().optional(),
  StopSignal: z.string().optional(),
  ArgsEscaped: z.boolean().optional(),
  Healthcheck: z
    .looseObject({
      Test: z.array(z.string()).optional(),
      Interval: z.number().optional(),
      Timeout: z.number().optional(),
      StartPeriod: z.number().optional(),
      Retries: z.number().optional(),
    })
    .optional(),
})
export type ImageConfigBlock = z.infer<typeof ImageConfigBlockSchema>

export const HistoryEntrySchema = z.looseObject({
  created: z.string().optional(),
  created_by: z.string().optional(),
  author: z.string().optional(),
  comment: z.string().optional(),
  empty_layer: z.boolean().optional(),
})
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

export const ImageConfigSchema = z.looseObject({
  created: z.string().optional(),
  author: z.string().optional(),
  architecture: z.string(),
  os: z.string(),
  "os.version": z.string().optional(),
  variant: z.string().optional(),
  config: ImageConfigBlockSchema.optional(),
  rootfs: z.object({
    type: z.literal("layers"),
    diff_ids: z.array(digestSchema),
  }),
  history: z.array(HistoryEntrySchema).optional(),
})
export type ImageConfig = z.infer<typeof ImageConfigSchema>

/** The `manifest.json` at the root of a `docker save` archive. */
export const DockerArchiveManifestSchema = z.array(
  z.looseObject({
    Config: z.string(),
    RepoTags: z.array(z.string()).nullable().optional(),
    Layers: z.array(z.string()),
  }),
)
export type DockerArchiveManifest = z.infer<typeof DockerArchiveManifestSchema>

export const OciLayoutSchema = z.looseObject({
  imageLayoutVersion: z.string(),
})

/**
 * Parse JSON bytes against a schema, reporting *what* failed rather than a bare
 * "invalid JSON". `what` names the document for the error message.
 */
export const parseJson = <T>(schema: z.ZodType<T>, bytes: Uint8Array | string, what: string): T => {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new ManifestError(`${what} is not valid JSON.`, { cause })
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n")
    throw new ManifestError(`${what} does not match the OCI schema:\n${issues}`)
  }
  return result.data
}

/**
 * JSON encoding for documents we digest. `JSON.stringify` preserves insertion order,
 * and we always assemble these objects in the same order, so the bytes — and therefore
 * the digest — are reproducible across builds.
 */
export const encodeJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value))
