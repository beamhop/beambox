import { posix } from "node:path"
import type { Readable } from "node:stream"
import { extract, pack as tarPack } from "tar-stream"

/**
 * How beambox works out what a `RUN` step changed.
 *
 * microsandbox composes the sandbox root as an overlay whose writable upper would be the
 * layer diff exactly — but that upper is not reachable from inside the guest, so it
 * cannot be read directly. Instead the guest's root filesystem is indexed before and
 * after each step and the two listings compared.
 *
 * `find -xdev` keeps the walk on the overlay itself: `/proc`, `/sys`, `/dev`, `/tmp`, and
 * beambox's own scratch mount are each a separate filesystem, so they fall out of the
 * listing for free rather than needing an exclusion list that could drift.
 */

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

export type EntryKind = "file" | "directory" | "symlink" | "other"

export interface RootfsEntry {
  /** Path inside the image, with no leading slash. */
  readonly path: string
  readonly size: number
  readonly mtime: number
  readonly rawMode: number
  readonly kind: EntryKind
}

export interface RootfsDiff {
  /** Paths that appeared or changed, sorted. */
  readonly changed: readonly RootfsEntry[]
  /** Paths that disappeared, sorted, recorded as `.wh.` whiteouts. */
  readonly deleted: readonly string[]
}

/** Parse the output of `busybox find / -xdev -exec busybox stat -c '%n|%s|%Y|%f' {} +`. */
export const parseListing = (listing: string): RootfsEntry[] => {
  const entries: RootfsEntry[] = []

  for (const line of listing.split("\n")) {
    if (line.trim() === "") continue
    const parts = line.split("|")
    if (parts.length < 4) continue

    const [name = "", size = "0", mtime = "0", rawModeHex = "0"] = parts
    const rawMode = Number.parseInt(rawModeHex, 16)
    if (Number.isNaN(rawMode)) continue

    const path = name.replace(/^\/+/, "").replace(/\/+$/, "")
    if (path === "") continue

    const type = rawMode & S_IFMT
    entries.push({
      path,
      size: Number(size) || 0,
      mtime: Number(mtime) || 0,
      rawMode,
      kind:
        type === S_IFDIR
          ? "directory"
          : type === S_IFLNK
            ? "symlink"
            : type === S_IFREG
              ? "file"
              : "other",
    })
  }

  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Compare two listings.
 *
 * A path counts as changed when it is new or when its size, mtime, or mode moved — the
 * same signals `rsync` and friends rely on. Content edited in place without any of those
 * changing would be missed, which is why nothing here writes files behind the runtime's
 * back.
 */
export const diffListings = (
  previous: readonly RootfsEntry[],
  current: readonly RootfsEntry[],
): RootfsDiff => {
  const before = new Map(previous.map((entry) => [entry.path, entry]))
  const after = new Set(current.map((entry) => entry.path))

  const changed = current.filter((entry) => {
    const old = before.get(entry.path)
    return (
      old === undefined ||
      old.size !== entry.size ||
      old.mtime !== entry.mtime ||
      old.rawMode !== entry.rawMode
    )
  })

  const deleted: string[] = []
  for (const entry of previous) {
    if (after.has(entry.path)) continue
    // A deleted directory covers its contents, so only the top of the subtree is recorded.
    if (deleted.some((parent) => entry.path.startsWith(`${parent}/`))) continue
    deleted.push(entry.path)
  }

  return { changed, deleted: deleted.sort() }
}

/**
 * Re-pack the guest-produced tar into a valid OCI layer.
 *
 * Directories are synthesised from the listing rather than being handed to `tar`, which
 * would otherwise recurse into them and drag in unchanged files from earlier steps.
 * Deletions become `.wh.` markers, the OCI convention for "this path is gone".
 *
 * File content is piped straight through, so a large layer never lands in memory.
 */
export const repackLayerTar = (source: Readable, diff: RootfsDiff): Readable => {
  const pack = tarPack()
  const header = { mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "" }

  const addDirectory = (path: string, mode: number): Promise<void> =>
    new Promise((resolve, reject) => {
      pack.entry({ ...header, name: `${path}/`, type: "directory", mode }, (error) =>
        error ? reject(error) : resolve(),
      )
    })

  const addWhiteout = (path: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const marker = posix.join(posix.dirname(path), `.wh.${posix.basename(path)}`)
      pack.entry({ ...header, name: marker, type: "file", mode: 0o644, size: 0 }, "", (error) =>
        error ? reject(error) : resolve(),
      )
    })

  const run = async (): Promise<void> => {
    for (const entry of diff.changed) {
      if (entry.kind === "directory") await addDirectory(entry.path, entry.rawMode & 0o7777)
    }
    for (const path of diff.deleted) await addWhiteout(path)

    const parser = extract()
    const emitted = new Set<string>()

    await new Promise<void>((resolve, reject) => {
      parser.on("entry", (incoming, stream, next) => {
        const name = incoming.name.replace(/^\.?\/+/, "").replace(/\/+$/, "")

        if (incoming.type === "directory" || name === "" || emitted.has(name)) {
          stream.on("end", next)
          stream.resume()
          return
        }
        emitted.add(name)

        if (incoming.type === "symlink") {
          pack.entry(
            {
              ...header,
              name,
              type: "symlink",
              linkname: incoming.linkname ?? "",
              mode: incoming.mode ?? 0o777,
            },
            (error) => (error ? reject(error) : next()),
          )
          stream.resume()
          return
        }

        const sink = pack.entry({
          ...header,
          name,
          type: "file",
          mode: incoming.mode ?? 0o644,
          size: incoming.size ?? 0,
        })
        stream.pipe(sink)
        sink.on("finish", next)
        sink.on("error", reject)
      })

      parser.on("finish", resolve)
      parser.on("error", reject)
      source.on("error", reject)
      source.pipe(parser)
    })

    pack.finalize()
  }

  run().catch((error: unknown) => {
    pack.destroy(error instanceof Error ? error : new Error(String(error)))
  })

  return pack
}
