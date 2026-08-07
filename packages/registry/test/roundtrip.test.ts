import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assembleImage,
  BlobStore,
  buildLayer,
  emptyImageConfig,
  parseReference,
} from "@beamhop/oci"
import { RegistryAuthError } from "../src/errors.ts"
import { pullImage } from "../src/pull.ts"
import { pushImage } from "../src/push.ts"
import { startTestRegistry, type TestRegistry } from "./registry-server.ts"

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

let registry: TestRegistry
let store: BlobStore
let dir: string

const buildSampleImage = async (target: BlobStore = store) => {
  const base = await buildLayer(target, [
    { kind: "file", path: "/base.txt", content: bytes("base") },
  ])
  const app = await buildLayer(target, [
    { kind: "file", path: "/app/main.js", content: bytes("app") },
  ])
  return await assembleImage(target, {
    config: {
      ...emptyImageConfig({ architecture: "arm64", os: "linux" }),
      config: { Cmd: ["node", "/app/main.js"], Env: ["NODE_ENV=production"] },
    },
    layers: [base, app],
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beambox-registry-"))
  store = new BlobStore(join(dir, "blobs"))
})

afterEach(async () => {
  registry?.stop()
  await rm(dir, { recursive: true, force: true })
})

describe("push and pull round trip", () => {
  test("an image survives a push followed by a pull into a clean store", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    await pushImage(image, reference, { insecure: true })

    const freshStore = new BlobStore(join(dir, "pulled"))
    const pulled = await pullImage(freshStore, reference, {
      insecure: true,
      platform: { architecture: "arm64", os: "linux" },
    })

    expect(pulled.manifestDescriptor.digest).toBe(image.manifestDescriptor.digest)
    expect(pulled.config.config?.Cmd).toEqual(["node", "/app/main.js"])
    expect(pulled.config.config?.Env).toEqual(["NODE_ENV=production"])
    expect(pulled.layers.map((layer) => layer.digest)).toEqual(
      image.layers.map((layer) => layer.digest),
    )
    expect(pulled.layers.map((layer) => layer.diffId)).toEqual(
      image.layers.map((layer) => layer.diffId),
    )
  })

  test("layer bytes survive the round trip intact", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)
    await pushImage(image, reference, { insecure: true })

    const freshStore = new BlobStore(join(dir, "pulled"))
    const pulled = await pullImage(freshStore, reference, {
      insecure: true,
      platform: { architecture: "arm64", os: "linux" },
    })

    const original = await image.layers[0]?.blob.bytes()
    const copy = await pulled.layers[0]?.blob.bytes()
    expect(
      Buffer.from(copy ?? new Uint8Array()).equals(Buffer.from(original ?? new Uint8Array())),
    ).toBe(true)
  })
})

describe("push", () => {
  test("skips blobs the registry already holds", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    const first: boolean[] = []
    await pushImage(image, reference, {
      insecure: true,
      onProgress: (event) => {
        if (event.what === "layer") first.push(event.skipped)
      },
    })
    expect(first).toEqual([false, false])

    // Pushing the same image again transfers nothing.
    const second: boolean[] = []
    await pushImage(image, reference, {
      insecure: true,
      onProgress: (event) => {
        if (event.what === "layer") second.push(event.skipped)
      },
    })
    expect(second).toEqual([true, true])
  })

  test("uploads every blob before the manifest that references them", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    // The test registry rejects a manifest naming an absent blob, so a successful push
    // is itself the assertion that ordering was correct.
    await pushImage(image, reference, { insecure: true })
    expect(registry.manifests.has("team/app:v1")).toBe(true)
    expect(registry.blobs.size).toBe(image.layers.length + 1)
  })
})

describe("authentication", () => {
  test("completes the bearer challenge and token exchange", async () => {
    registry = startTestRegistry({ requireAuth: true })
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    await pushImage(image, reference, { insecure: true, useDockerCredentials: false })
    expect(registry.requests.some((request) => request.path === "/token")).toBe(true)
  })

  test("sends basic credentials to the token endpoint", async () => {
    registry = startTestRegistry({
      requireAuth: true,
      credentials: { username: "deploy", password: "s3cret" },
    })
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    await pushImage(image, reference, {
      insecure: true,
      auth: { kind: "basic", username: "deploy", password: "s3cret" },
    })
    expect(registry.manifests.has("team/app:v1")).toBe(true)
  })

  test("fails loudly with the wrong credentials rather than pushing anonymously", async () => {
    registry = startTestRegistry({
      requireAuth: true,
      credentials: { username: "deploy", password: "s3cret" },
    })
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)

    await expect(
      pushImage(image, reference, {
        insecure: true,
        auth: { kind: "basic", username: "deploy", password: "wrong" },
      }),
    ).rejects.toThrow(RegistryAuthError)
  })
})

describe("pull", () => {
  test("reuses cached layers instead of downloading them again", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)
    await pushImage(image, reference, { insecure: true })

    // The same store already holds every layer, so nothing should be fetched.
    const cached: boolean[] = []
    await pullImage(store, reference, {
      insecure: true,
      platform: { architecture: "arm64", os: "linux" },
      onProgress: (event) => cached.push(event.cached),
    })
    expect(cached).toEqual([true, true])
  })

  test("verifies layer digests, rejecting a registry that serves corrupted bytes", async () => {
    registry = startTestRegistry()
    const image = await buildSampleImage()
    const reference = parseReference(`${registry.host}/team/app:v1`)
    await pushImage(image, reference, { insecure: true })

    // Corrupt a layer in the registry's storage after the fact.
    const target = image.layers[0]?.digest ?? ""
    registry.blobs.set(target, bytes("this is not the layer you are looking for"))

    const freshStore = new BlobStore(join(dir, "pulled"))
    await expect(
      pullImage(freshStore, reference, {
        insecure: true,
        platform: { architecture: "arm64", os: "linux" },
      }),
    ).rejects.toThrow(/Digest mismatch/)
  })
})
