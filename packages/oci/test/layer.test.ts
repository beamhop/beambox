import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BlobStore } from "../src/blob.ts"
import { buildLayer, normalizeLayerPath } from "../src/layer.ts"
import { OCI_LAYER_GZIP, OCI_LAYER_TAR } from "../src/media-types.ts"
import { bytes, readTar, text, withStore } from "./helpers.ts"

let store: BlobStore
let dir: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  const context = await withStore()
  store = context.store
  dir = context.dir
  cleanup = context.cleanup
})
afterEach(() => cleanup())

describe("normalizeLayerPath", () => {
  test("strips leading slashes and redundant segments", () => {
    expect(normalizeLayerPath("/app/./bin/")).toBe("app/bin")
    expect(normalizeLayerPath("app//bin")).toBe("app/bin")
    expect(normalizeLayerPath("/")).toBe("")
  })

  test("rejects traversal rather than clamping it", () => {
    expect(() => normalizeLayerPath("/app/../../etc/passwd")).toThrow(/escapes the root/)
  })
})

describe("buildLayer", () => {
  test("sorts entries and synthesises parent directories", async () => {
    const layer = await buildLayer(store, [
      { kind: "file", path: "/usr/local/bin/tool", content: bytes("x") },
      { kind: "file", path: "/etc/config", content: bytes("y") },
    ])

    const entries = await readTar(layer.blob.stream(), { gzip: true })
    expect(entries.map((entry) => entry.name)).toEqual([
      "etc/",
      "etc/config",
      "usr/",
      "usr/local/",
      "usr/local/bin/",
      "usr/local/bin/tool",
    ])
  })

  test("an explicit directory keeps its mode when it is also an implied parent", async () => {
    const layer = await buildLayer(store, [
      { kind: "file", path: "/app/main", content: bytes("x") },
      { kind: "directory", path: "/app", mode: 0o700 },
    ])

    const entries = await readTar(layer.blob.stream(), { gzip: true })
    const app = entries.find((entry) => entry.name === "app/")
    expect(app?.mode).toBe(0o700)
  })

  test("pins mtime, uid, and gid so digests do not drift", async () => {
    const layer = await buildLayer(store, [{ kind: "file", path: "a", content: bytes("x") }])
    const entries = await readTar(layer.blob.stream(), { gzip: true })

    for (const entry of entries) {
      expect(entry.mtimeMs).toBe(0)
      expect(entry.uid).toBe(0)
      expect(entry.gid).toBe(0)
    }
  })

  test("identical content produces an identical digest regardless of entry order", async () => {
    const first = await buildLayer(store, [
      { kind: "file", path: "/b.txt", content: bytes("bee") },
      { kind: "file", path: "/a.txt", content: bytes("ay") },
    ])
    const second = await buildLayer(store, [
      { kind: "file", path: "/a.txt", content: bytes("ay") },
      { kind: "file", path: "/b.txt", content: bytes("bee") },
    ])

    expect(second.digest).toBe(first.digest)
    expect(second.diffId).toBe(first.diffId)
  })

  test("distinguishes the compressed digest from the diff ID", async () => {
    const layer = await buildLayer(store, [
      { kind: "file", path: "a", content: bytes("x".repeat(4096)) },
    ])

    expect(layer.mediaType).toBe(OCI_LAYER_GZIP)
    expect(layer.digest).not.toBe(layer.diffId)
    // gzip actually shrank it, so the two sizes must not be interchangeable either
    expect(layer.size).toBeLessThan(layer.diffSize)
  })

  test("uncompressed layers report matching digest and diff ID", async () => {
    const layer = await buildLayer(store, [{ kind: "file", path: "a", content: bytes("x") }], {
      compress: false,
    })

    expect(layer.mediaType).toBe(OCI_LAYER_TAR)
    expect(layer.digest).toBe(layer.diffId)
    expect(layer.size).toBe(layer.diffSize)
  })

  test("writes symlinks as symlinks", async () => {
    const layer = await buildLayer(store, [
      { kind: "file", path: "/bin/busybox", content: bytes("elf"), mode: 0o755 },
      { kind: "symlink", path: "/bin/sh", target: "busybox" },
    ])

    const entries = await readTar(layer.blob.stream(), { gzip: true })
    const link = entries.find((entry) => entry.name === "bin/sh")
    expect(link?.type).toBe("symlink")
    expect(link?.linkname).toBe("busybox")
  })

  test("whiteouts become .wh. markers and opaque dirs become .wh..wh..opq", async () => {
    const layer = await buildLayer(store, [
      { kind: "whiteout", path: "/etc/hosts" },
      { kind: "opaque", path: "/var/cache" },
    ])

    const entries = await readTar(layer.blob.stream(), { gzip: true })
    const names = entries.map((entry) => entry.name)
    expect(names).toContain("etc/.wh.hosts")
    expect(names).toContain("var/cache/.wh..wh..opq")

    const marker = entries.find((entry) => entry.name === "etc/.wh.hosts")
    expect(marker?.content.byteLength).toBe(0)
  })

  test("streams file content from disk", async () => {
    const path = `${dir}/streamed.txt`
    await Bun.write(path, "streamed from disk")
    const size = Bun.file(path).size

    const layer = await buildLayer(store, [
      { kind: "file", path: "/data.txt", content: { file: path, size } },
    ])

    const entries = await readTar(layer.blob.stream(), { gzip: true })
    const entry = entries.find((item) => item.name === "data.txt")
    expect(text(entry?.content ?? new Uint8Array())).toBe("streamed from disk")
  })
})
