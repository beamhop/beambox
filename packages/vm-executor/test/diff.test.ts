import { describe, expect, test } from "bun:test"
import type { Readable } from "node:stream"
import { pack as tarPack } from "tar-stream"
import { diffListings, parseListing, repackLayerTar } from "../src/diff.ts"

/** Build the exact text `busybox stat -c '%n|%s|%Y|%f'` produces. */
const listing = (rows: readonly [string, number, number, number][]): string =>
  rows
    .map(([name, size, mtime, mode]) => `${name}|${size}|${mtime}|${mode.toString(16)}`)
    .join("\n")

const REG = 0o100644
const DIR = 0o040755
const LNK = 0o120777

const readTar = async (
  source: Readable,
): Promise<{ name: string; type: string; content: string }[]> => {
  const { extract } = await import("tar-stream")
  const entries: { name: string; type: string; content: string }[] = []
  const parser = extract()

  parser.on("entry", (header, stream, next) => {
    const chunks: Uint8Array[] = []
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    stream.on("end", () => {
      entries.push({
        name: header.name,
        type: String(header.type),
        content: Buffer.concat(chunks).toString("utf8"),
      })
      next()
    })
    stream.resume()
  })

  await new Promise<void>((resolve, reject) => {
    parser.on("finish", resolve)
    parser.on("error", reject)
    source.on("error", reject)
    source.pipe(parser)
  })
  return entries
}

const tarOf = (files: readonly { name: string; content: string }[]): Readable => {
  const pack = tarPack()
  for (const file of files) {
    pack.entry({ name: file.name, size: file.content.length, mode: 0o644 }, file.content)
  }
  pack.finalize()
  return pack
}

describe("parseListing", () => {
  test("classifies files, directories, and symlinks by mode bits", () => {
    const entries = parseListing(
      listing([
        ["/etc/hosts", 120, 1000, REG],
        ["/opt", 4096, 1000, DIR],
        ["/bin/sh", 7, 1000, LNK],
      ]),
    )

    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["bin/sh", "symlink"],
      ["etc/hosts", "file"],
      ["opt", "directory"],
    ])
  })

  test("strips the leading slash so paths are image-relative", () => {
    expect(parseListing(listing([["/opt/app", 1, 1, REG]]))[0]?.path).toBe("opt/app")
  })

  test("ignores blank and malformed lines rather than failing the build", () => {
    const entries = parseListing(`\n/ok|1|1|${REG.toString(16)}\ngarbage\n\n`)
    expect(entries).toHaveLength(1)
  })

  test("returns entries sorted, so layers do not depend on walk order", () => {
    const entries = parseListing(
      listing([
        ["/z", 1, 1, REG],
        ["/a", 1, 1, REG],
        ["/m", 1, 1, REG],
      ]),
    )
    expect(entries.map((entry) => entry.path)).toEqual(["a", "m", "z"])
  })
})

describe("diffListings", () => {
  const before = parseListing(
    listing([
      ["/keep", 10, 100, REG],
      ["/change", 10, 100, REG],
      ["/gone", 10, 100, REG],
      ["/dir", 4096, 100, DIR],
      ["/dir/child", 5, 100, REG],
    ]),
  )

  test("detects new files", () => {
    const after = parseListing(
      listing([
        ["/keep", 10, 100, REG],
        ["/change", 10, 100, REG],
        ["/gone", 10, 100, REG],
        ["/dir", 4096, 100, DIR],
        ["/dir/child", 5, 100, REG],
        ["/brand-new", 3, 200, REG],
      ]),
    )
    expect(diffListings(before, after).changed.map((entry) => entry.path)).toEqual(["brand-new"])
  })

  test("detects changes in size, mtime, or mode", () => {
    const bySize = parseListing(listing([["/change", 99, 100, REG]]))
    const byMtime = parseListing(listing([["/change", 10, 999, REG]]))
    const byMode = parseListing(listing([["/change", 10, 100, 0o100755]]))

    for (const after of [bySize, byMtime, byMode]) {
      expect(diffListings(before, after).changed.map((entry) => entry.path)).toContain("change")
    }
  })

  test("reports nothing for an unchanged filesystem", () => {
    const diff = diffListings(before, before)
    expect(diff.changed).toHaveLength(0)
    expect(diff.deleted).toHaveLength(0)
  })

  test("records deletions", () => {
    const after = parseListing(
      listing([
        ["/keep", 10, 100, REG],
        ["/change", 10, 100, REG],
        ["/dir", 4096, 100, DIR],
        ["/dir/child", 5, 100, REG],
      ]),
    )
    expect(diffListings(before, after).deleted).toEqual(["gone"])
  })

  test("collapses a deleted subtree to its root", () => {
    const after = parseListing(
      listing([
        ["/keep", 10, 100, REG],
        ["/change", 10, 100, REG],
        ["/gone", 10, 100, REG],
      ]),
    )
    // Whiteout the directory itself, not each file inside it.
    expect(diffListings(before, after).deleted).toEqual(["dir"])
  })
})

describe("repackLayerTar", () => {
  test("synthesises directory entries from the listing", async () => {
    const diff = diffListings([], parseListing(listing([["/opt/app", 4096, 1, DIR]])))
    const entries = await readTar(repackLayerTar(tarOf([]), diff))

    expect(entries.map((entry) => entry.name)).toEqual(["opt/app/"])
    expect(entries[0]?.type).toBe("directory")
  })

  test("turns deletions into .wh. markers", async () => {
    const before = parseListing(listing([["/etc/motd", 1, 1, REG]]))
    const diff = diffListings(before, [])
    const entries = await readTar(repackLayerTar(tarOf([]), diff))

    expect(entries.map((entry) => entry.name)).toEqual(["etc/.wh.motd"])
    expect(entries[0]?.content).toBe("")
  })

  test("passes file content through unchanged", async () => {
    const diff = diffListings([], parseListing(listing([["/opt/marker", 5, 1, REG]])))
    const entries = await readTar(
      repackLayerTar(tarOf([{ name: "opt/marker", content: "hello" }]), diff),
    )

    const file = entries.find((entry) => entry.name === "opt/marker")
    expect(file?.content).toBe("hello")
  })

  test("emits directories before the files inside them", async () => {
    const diff = diffListings(
      [],
      parseListing(
        listing([
          ["/opt", 4096, 1, DIR],
          ["/opt/file", 2, 1, REG],
        ]),
      ),
    )
    const entries = await readTar(
      repackLayerTar(tarOf([{ name: "opt/file", content: "hi" }]), diff),
    )

    expect(entries.map((entry) => entry.name)).toEqual(["opt/", "opt/file"])
  })

  test("drops duplicate entries so a layer never carries the same path twice", async () => {
    const diff = diffListings([], parseListing(listing([["/dup", 1, 1, REG]])))
    const entries = await readTar(
      repackLayerTar(
        tarOf([
          { name: "dup", content: "a" },
          { name: "dup", content: "b" },
        ]),
        diff,
      ),
    )

    expect(entries.filter((entry) => entry.name === "dup")).toHaveLength(1)
  })

  test("normalises ./-prefixed names, which tar writers commonly emit", async () => {
    const diff = diffListings([], parseListing(listing([["/opt/x", 1, 1, REG]])))
    const entries = await readTar(repackLayerTar(tarOf([{ name: "./opt/x", content: "y" }]), diff))
    expect(entries.map((entry) => entry.name)).toContain("opt/x")
  })
})
