import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { writeArchive, writeLayoutDirectory } from "../src/archive.ts"
import type { BlobStore } from "../src/blob.ts"
import { digestHex } from "../src/digest.ts"
import { assembleImage, emptyImageConfig, type ImageArtifact } from "../src/image.ts"
import { buildLayer } from "../src/layer.ts"
import { DockerArchiveManifestSchema, IndexSchema, ManifestSchema, parseJson } from "../src/spec.ts"
import { bytes, readTar, readTarFromFile, text, withStore } from "./helpers.ts"

let store: BlobStore
let dir: string
let cleanup: () => Promise<void>
let image: ImageArtifact

beforeEach(async () => {
  const context = await withStore()
  store = context.store
  dir = context.dir
  cleanup = context.cleanup

  const first = await buildLayer(store, [
    { kind: "file", path: "/base.txt", content: bytes("base") },
  ])
  const second = await buildLayer(store, [
    { kind: "file", path: "/app/main.js", content: bytes("run") },
  ])

  image = await assembleImage(store, {
    config: {
      ...emptyImageConfig({ architecture: "arm64", os: "linux" }),
      config: { Cmd: ["node", "/app/main.js"], Env: ["NODE_ENV=production"], WorkingDir: "/app" },
    },
    layers: [first, second],
  })
})
afterEach(() => cleanup())

describe("docker archive", () => {
  test("has the layout msb and docker expect", async () => {
    const output = join(dir, "image.tar")
    await writeArchive(image, output, { tags: ["app:local"] })

    const entries = await readTarFromFile(output)
    const names = entries.map((entry) => entry.name)

    expect(names[0]).toBe("manifest.json")
    expect(names).toContain(`${digestHex(image.configDescriptor.digest)}.json`)

    for (const layer of image.layers) {
      const id = digestHex(layer.diffId)
      expect(names).toContain(`${id}/VERSION`)
      expect(names).toContain(`${id}/json`)
      expect(names).toContain(`${id}/layer.tar`)
    }

    const version = entries.find((entry) => entry.name.endsWith("/VERSION"))
    expect(text(version?.content ?? new Uint8Array())).toBe("1.0")
  })

  test("manifest.json points at the config and every layer in order", async () => {
    const output = join(dir, "image.tar")
    await writeArchive(image, output, { tags: ["app:local", "app:v1"] })

    const entries = await readTarFromFile(output)
    const raw = entries.find((entry) => entry.name === "manifest.json")
    const manifest = parseJson(
      DockerArchiveManifestSchema,
      raw?.content ?? new Uint8Array(),
      "manifest.json",
    )

    expect(manifest).toHaveLength(1)
    expect(manifest[0]?.RepoTags).toEqual(["app:local", "app:v1"])
    expect(manifest[0]?.Config).toBe(`${digestHex(image.configDescriptor.digest)}.json`)
    expect(manifest[0]?.Layers).toEqual(
      image.layers.map((layer) => `${digestHex(layer.diffId)}/layer.tar`),
    )
  })

  test("stores layers uncompressed, as the format requires", async () => {
    const output = join(dir, "image.tar")
    await writeArchive(image, output, { tags: ["app:local"] })

    const entries = await readTarFromFile(output)
    const layerEntry = entries.find((entry) => entry.name.endsWith("/layer.tar"))
    expect(layerEntry).toBeDefined()

    // Readable as a plain tar — no gunzip — and the declared size matches the real bytes.
    const inner = await readTar(
      (await import("node:stream")).Readable.from([layerEntry?.content ?? new Uint8Array()]),
    )
    expect(inner.map((entry) => entry.name)).toContain("base.txt")
    expect(layerEntry?.content.byteLength).toBe(image.layers[0]?.diffSize)
  })

  test("records null RepoTags when untagged, which is what docker load expects", async () => {
    const output = join(dir, "image.tar")
    await writeArchive(image, output)

    const entries = await readTarFromFile(output)
    const raw = entries.find((entry) => entry.name === "manifest.json")
    const manifest = parseJson(
      DockerArchiveManifestSchema,
      raw?.content ?? new Uint8Array(),
      "manifest.json",
    )
    expect(manifest[0]?.RepoTags).toBeNull()
  })
})

describe("oci archive", () => {
  test("is a valid image layout with tagged manifests", async () => {
    const output = join(dir, "image.oci.tar")
    await writeArchive(image, output, { tags: ["app:local"], format: "oci" })

    const entries = await readTarFromFile(output)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain("oci-layout")
    expect(names).toContain("index.json")

    const indexRaw = entries.find((entry) => entry.name === "index.json")
    const index = parseJson(IndexSchema, indexRaw?.content ?? new Uint8Array(), "index.json")

    expect(index.manifests).toHaveLength(1)
    expect(index.manifests[0]?.digest).toBe(image.manifestDescriptor.digest)
    expect(index.manifests[0]?.annotations?.["org.opencontainers.image.ref.name"]).toBe("app:local")
  })

  test("contains a blob for the manifest, the config, and every layer", async () => {
    const output = join(dir, "image.oci.tar")
    await writeArchive(image, output, { tags: ["app:local"], format: "oci" })

    const entries = await readTarFromFile(output)
    const names = new Set(entries.map((entry) => entry.name))

    expect(names.has(`blobs/sha256/${digestHex(image.manifestDescriptor.digest)}`)).toBe(true)
    expect(names.has(`blobs/sha256/${digestHex(image.configDescriptor.digest)}`)).toBe(true)
    for (const layer of image.layers) {
      expect(names.has(`blobs/sha256/${digestHex(layer.digest)}`)).toBe(true)
    }

    // The manifest blob really is the manifest, and its layers line up with the image.
    const manifestRaw = entries.find(
      (entry) => entry.name === `blobs/sha256/${digestHex(image.manifestDescriptor.digest)}`,
    )
    const manifest = parseJson(ManifestSchema, manifestRaw?.content ?? new Uint8Array(), "manifest")
    expect(manifest.layers.map((layer) => layer.digest)).toEqual(
      image.layers.map((layer) => layer.digest),
    )
  })

  test("emits one tagged manifest entry per tag", async () => {
    const output = join(dir, "image.oci.tar")
    await writeArchive(image, output, { tags: ["app:local", "app:v1"], format: "oci" })

    const entries = await readTarFromFile(output)
    const indexRaw = entries.find((entry) => entry.name === "index.json")
    const index = parseJson(IndexSchema, indexRaw?.content ?? new Uint8Array(), "index.json")

    expect(
      index.manifests.map(
        (descriptor) => descriptor.annotations?.["org.opencontainers.image.ref.name"],
      ),
    ).toEqual(["app:local", "app:v1"])
  })
})

describe("layout directory", () => {
  test("writes an unpacked layout that skopeo and crane can read", async () => {
    const layout = join(dir, "layout")
    await writeLayoutDirectory(image, layout, { tags: ["app:local"] })

    expect(await Bun.file(join(layout, "oci-layout")).json()).toEqual({
      imageLayoutVersion: "1.0.0",
    })

    const index = parseJson(
      IndexSchema,
      await Bun.file(join(layout, "index.json")).text(),
      "index.json",
    )
    expect(index.manifests[0]?.digest).toBe(image.manifestDescriptor.digest)

    for (const layer of image.layers) {
      const blob = Bun.file(join(layout, "blobs", "sha256", digestHex(layer.digest)))
      expect(await blob.exists()).toBe(true)
      expect(blob.size).toBe(layer.size)
    }
  })
})

describe("assembleImage", () => {
  test("derives rootfs.diff_ids from the layers rather than trusting the config", async () => {
    const layer = await buildLayer(store, [{ kind: "file", path: "/x", content: bytes("x") }])
    const built = await assembleImage(store, {
      config: {
        ...emptyImageConfig({ architecture: "arm64", os: "linux" }),
        // A deliberately wrong diff ID that must be overwritten.
        rootfs: { type: "layers", diff_ids: [`sha256:${"0".repeat(64)}`] },
      },
      layers: [layer],
    })

    expect(built.config.rootfs.diff_ids).toEqual([layer.diffId])
  })

  test("produces a manifest whose descriptor sizes match the stored blobs", async () => {
    expect(image.manifestDescriptor.size).toBe(image.manifestBlob.size)
    expect(image.configDescriptor.size).toBe(image.configBlob.size)
    expect(image.manifest.layers.map((layer) => layer.size)).toEqual(
      image.layers.map((layer) => layer.size),
    )
  })
})
