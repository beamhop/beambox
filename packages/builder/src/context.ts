import { createReadStream } from "node:fs"
import { lstat, readdir, readlink } from "node:fs/promises"
import { isAbsolute, join, posix, relative, resolve } from "node:path"
import { createGunzip } from "node:zlib"
import type { LayerEntry } from "@beambox/oci"
import { extract } from "tar-stream"
import { CopySourceError } from "./errors.ts"
import type { CopySource } from "./spec.ts"

/**
 * A `.dockerignore` matcher.
 *
 * Docker's rules are order-sensitive: the *last* pattern that matches decides, and a
 * leading `!` re-includes. So this keeps the patterns in order rather than collapsing
 * them into a set.
 */
export interface IgnoreMatcher {
  ignores(relativePath: string): boolean
}

const ALWAYS_IGNORED = new Set([".dockerignore", "Dockerfile"])

export const parseDockerignore = (contents: string): IgnoreMatcher => {
  const patterns = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!")
      const body = (negated ? line.slice(1) : line).replace(/^\.?\//, "").replace(/\/$/, "")
      return { negated, glob: new Bun.Glob(body), body }
    })

  return {
    ignores(relativePath: string): boolean {
      let ignored = false
      for (const pattern of patterns) {
        // A directory pattern also covers everything beneath it.
        const matched =
          pattern.glob.match(relativePath) ||
          relativePath === pattern.body ||
          relativePath.startsWith(`${pattern.body}/`)
        if (matched) ignored = !pattern.negated
      }
      return ignored
    },
  }
}

export const loadDockerignore = async (contextDir: string): Promise<IgnoreMatcher> => {
  const file = Bun.file(join(contextDir, ".dockerignore"))
  if (!(await file.exists())) return { ignores: () => false }
  return parseDockerignore(await file.text())
}

/** `--chown=1000:1000`. Names need the image's `/etc/passwd`, which we do not read. */
const parseChown = (chown: string | undefined): { uid: number; gid: number } | undefined => {
  if (chown === undefined) return undefined

  const [user = "", group = user] = chown.split(":")
  const uid = Number(user)
  const gid = Number(group)

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new CopySourceError(
      chown,
      `uses names rather than numeric IDs. beambox resolves --chown on the host and cannot ` +
        `read the image's /etc/passwd, so use numeric IDs (for example --chown=1000:1000).`,
    )
  }
  return { uid, gid }
}

const parseChmod = (chmod: string | undefined): number | undefined => {
  if (chmod === undefined) return undefined
  const mode = Number.parseInt(chmod, 8)
  if (Number.isNaN(mode)) throw new CopySourceError(chmod, `is not an octal mode.`)
  return mode
}

interface HostEntry {
  readonly absolute: string
  /** Path relative to the copy root, used to build the destination path. */
  readonly relative: string
}

/** Recursively list a directory, honouring `.dockerignore`. */
const walk = async (
  root: string,
  ignore: IgnoreMatcher,
  contextRoot: string,
  prefix = "",
): Promise<HostEntry[]> => {
  const found: HostEntry[] = []
  for (const item of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, item.name)
    const fromContext = relative(contextRoot, absolute)
    if (ignore.ignores(fromContext) || ALWAYS_IGNORED.has(fromContext)) continue

    const relativePath = prefix === "" ? item.name : posix.join(prefix, item.name)
    found.push({ absolute, relative: relativePath })
    if (item.isDirectory()) {
      found.push(...(await walk(absolute, ignore, contextRoot, relativePath)))
    }
  }
  return found
}

const toLayerEntry = async (
  entry: HostEntry,
  destination: string,
  ownership: { uid: number; gid: number } | undefined,
  mode: number | undefined,
): Promise<LayerEntry> => {
  const stats = await lstat(entry.absolute)
  const attributes = {
    path: destination,
    ...(ownership ? { uid: ownership.uid, gid: ownership.gid } : {}),
  }

  if (stats.isSymbolicLink()) {
    return { kind: "symlink", ...attributes, target: await readlink(entry.absolute) }
  }
  if (stats.isDirectory()) {
    return { kind: "directory", ...attributes, mode: mode ?? stats.mode & 0o7777 }
  }
  return {
    kind: "file",
    ...attributes,
    mode: mode ?? stats.mode & 0o7777,
    content: { file: entry.absolute, size: stats.size },
  }
}

/** Guard against a context path escaping the context directory via `..` or an absolute path. */
const resolveWithinContext = (contextDir: string, source: string): string => {
  const target = resolve(contextDir, source)
  const inside = relative(contextDir, target)
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new CopySourceError(source, `resolves outside the build context.`)
  }
  return target
}

/**
 * Turn a `COPY`/`ADD` into layer entries.
 *
 * Follows Dockerfile's destination rules: copying a directory contributes its *contents*,
 * not the directory itself; a destination ending in `/`, or any copy with more than one
 * source, is treated as a directory.
 */
export const resolveCopy = async (
  contextDir: string,
  op: CopySource,
  ignore: IgnoreMatcher,
): Promise<LayerEntry[]> => {
  const ownership = parseChown(op.chown)
  const mode = parseChmod(op.chmod)
  const destinationIsDirectory = op.destination.endsWith("/") || op.sources.length > 1
  const destination = op.destination.replace(/\/+$/, "")

  const entries: LayerEntry[] = []

  for (const source of op.sources) {
    const hasGlob = /[*?[\]{}]/.test(source)
    const matches: string[] = []

    if (hasGlob) {
      const glob = new Bun.Glob(source)
      for await (const match of glob.scan({ cwd: contextDir, dot: true, onlyFiles: false })) {
        if (!ignore.ignores(match)) matches.push(match)
      }
      if (matches.length === 0) throw new CopySourceError(source, `matched no files.`)
    } else {
      matches.push(source)
    }

    for (const match of matches) {
      const absolute = resolveWithinContext(contextDir, match)
      const stats = await lstat(absolute).catch(() => undefined)
      if (!stats) throw new CopySourceError(match, `does not exist in the build context.`)

      if (stats.isDirectory()) {
        // A directory contributes its contents, and the destination is that directory.
        const root = destinationIsDirectory
          ? posix.join(destination, posix.basename(match))
          : destination
        entries.push({
          kind: "directory",
          path: root,
          ...(ownership ? { uid: ownership.uid, gid: ownership.gid } : {}),
          mode: mode ?? stats.mode & 0o7777,
        })
        for (const item of await walk(absolute, ignore, contextDir, "")) {
          entries.push(await toLayerEntry(item, posix.join(root, item.relative), ownership, mode))
        }
      } else {
        const target = destinationIsDirectory
          ? posix.join(destination, posix.basename(match))
          : destination
        entries.push(await toLayerEntry({ absolute, relative: match }, target, ownership, mode))
      }
    }
  }

  if (entries.length === 0) throw new CopySourceError(op.sources.join(" "), `matched no files.`)
  return entries
}

const TAR_EXTENSIONS = [".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz", ".tar.xz", ".txz"]

export const looksLikeArchive = (path: string): boolean =>
  TAR_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))

/**
 * Expand a local tar into layer entries — `ADD`'s auto-extraction behaviour.
 *
 * Only gzip and plain tar are handled; bzip2 and xz would need a decompressor we do not
 * ship, and silently copying the archive instead of extracting it would be worse than
 * saying so.
 */
export const extractArchive = async (
  archivePath: string,
  destination: string,
): Promise<LayerEntry[]> => {
  const lower = archivePath.toLowerCase()
  if (
    lower.endsWith(".tar.bz2") ||
    lower.endsWith(".tbz") ||
    lower.endsWith(".tar.xz") ||
    lower.endsWith(".txz")
  ) {
    throw new CopySourceError(
      archivePath,
      `uses bzip2 or xz compression, which beambox cannot expand. Recompress it as .tar.gz.`,
    )
  }

  const gzip = lower.endsWith(".gz") || lower.endsWith(".tgz")
  const parser = extract()
  const entries: LayerEntry[] = []

  parser.on("entry", (header, stream, next) => {
    const target = posix.join(destination, header.name)
    const chunks: Uint8Array[] = []

    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    stream.on("end", () => {
      const attributes = {
        path: target,
        mode: header.mode ?? 0o644,
        uid: header.uid ?? 0,
        gid: header.gid ?? 0,
      }
      if (header.type === "directory") entries.push({ kind: "directory", ...attributes })
      else if (header.type === "symlink") {
        entries.push({ kind: "symlink", ...attributes, target: header.linkname ?? "" })
      } else if (header.type === "file") {
        entries.push({ kind: "file", ...attributes, content: Buffer.concat(chunks) })
      }
      next()
    })
    stream.resume()
  })

  const source = createReadStream(archivePath)
  await new Promise<void>((resolvePromise, reject) => {
    parser.on("finish", resolvePromise)
    parser.on("error", reject)
    source.on("error", reject)
    ;(gzip ? source.pipe(createGunzip()) : source).pipe(parser)
  })

  return entries
}
