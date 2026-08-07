import { DockerfileParseError } from "./errors.ts"

/** One instruction, with continuations joined and heredoc bodies attached. */
export interface LogicalLine {
  readonly instruction: string
  readonly args: string
  /** 1-based line number the instruction started on. */
  readonly line: number
  /** Raw text, for error messages. */
  readonly source: string
  /** Heredoc bodies keyed by delimiter, for `RUN <<EOF … EOF`. */
  readonly heredocs: ReadonlyMap<string, string>
}

const DIRECTIVE = /^#\s*(escape|syntax)\s*=\s*(\S+)\s*$/i

export interface LexResult {
  readonly lines: readonly LogicalLine[]
  /** The escape character in force, `\` unless a directive changed it. */
  readonly escape: string
  /** A `# syntax=` directive, if one was present. */
  readonly syntax?: string
}

const HEREDOC = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g

/**
 * Turn Dockerfile text into logical lines.
 *
 * This deals with the three things that make Dockerfile text not line-oriented:
 * continuations (a trailing escape character joins the next line), comments (which are
 * stripped, but only when they are whole lines — a `#` mid-instruction is data), and
 * heredocs, whose body must be collected verbatim rather than parsed.
 */
export const lex = (text: string): LexResult => {
  const rawLines = text.split(/\r?\n/)
  let escapeChar = "\\"
  let syntax: string | undefined

  // Parser directives are only recognised before any instruction or ordinary comment.
  let cursor = 0
  while (cursor < rawLines.length) {
    const candidate = rawLines[cursor]
    if (candidate === undefined) break
    const match = DIRECTIVE.exec(candidate.trim())
    if (!match) break
    if (match[1]?.toLowerCase() === "escape") escapeChar = match[2] ?? "\\"
    else syntax = match[2]
    cursor += 1
  }

  const lines: LogicalLine[] = []

  while (cursor < rawLines.length) {
    const startIndex = cursor
    const first = rawLines[cursor] ?? ""

    if (first.trim() === "" || first.trimStart().startsWith("#")) {
      cursor += 1
      continue
    }

    // Join continuations: a trailing escape character means the instruction carries on.
    const parts: string[] = []
    for (;;) {
      const line = rawLines[cursor]
      if (line === undefined) break

      // A comment sitting inside a continuation is dropped, as Docker does.
      if (parts.length > 0 && line.trimStart().startsWith("#")) {
        cursor += 1
        continue
      }

      const withoutTrailing = line.trimEnd()
      if (withoutTrailing.endsWith(escapeChar)) {
        parts.push(withoutTrailing.slice(0, -escapeChar.length))
        cursor += 1
        continue
      }
      parts.push(line)
      break
    }

    // Only the joins are normalised — inner whitespace is data, and collapsing it would
    // corrupt quoted arguments and shell commands.
    const joined = parts
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ")
    const source = rawLines.slice(startIndex, cursor + 1).join("\n")
    cursor += 1

    const separator = joined.search(/\s/)
    const instruction = (separator === -1 ? joined : joined.slice(0, separator)).toUpperCase()
    const args = separator === -1 ? "" : joined.slice(separator + 1).trim()

    if (instruction === "") continue

    // Collect any heredoc bodies this instruction opened.
    const heredocs = new Map<string, string>()
    const delimiters = [...args.matchAll(HEREDOC)].map((match) => match[2] ?? "")
    for (const delimiter of delimiters) {
      const body: string[] = []
      let closed = false
      while (cursor < rawLines.length) {
        const bodyLine = rawLines[cursor]
        cursor += 1
        if (bodyLine === undefined) break
        if (bodyLine.trim() === delimiter) {
          closed = true
          break
        }
        body.push(bodyLine)
      }
      if (!closed) {
        throw new DockerfileParseError(
          startIndex + 1,
          `heredoc <<${delimiter} was never closed`,
          source,
        )
      }
      heredocs.set(delimiter, body.join("\n"))
    }

    lines.push({ instruction, args, line: startIndex + 1, source, heredocs })
  }

  return { lines, escape: escapeChar, ...(syntax !== undefined ? { syntax } : {}) }
}

/**
 * Split an argument string into words, honouring quotes and escapes.
 *
 * Dockerfile is not shell, but it does respect quoting well enough that
 * `COPY "my file.txt" /dest` has to work.
 */
export const splitWords = (args: string): string[] => {
  const words: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false

  for (let index = 0; index < args.length; index += 1) {
    const character = args[index]

    if (character === "\\" && quote !== "'" && index + 1 < args.length) {
      current += args[index + 1]
      started = true
      index += 1
      continue
    }
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character
      started = true
      continue
    }
    if (character === quote) {
      quote = undefined
      continue
    }
    if (quote === undefined && character !== undefined && /\s/.test(character)) {
      if (started) words.push(current)
      current = ""
      started = false
      continue
    }
    current += character
    started = true
  }

  if (started) words.push(current)
  return words
}

/** Leading `--flag=value` arguments, and whatever follows them. */
export const takeFlags = (
  words: readonly string[],
): { flags: Map<string, string>; rest: string[] } => {
  const flags = new Map<string, string>()
  let index = 0

  for (; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined || !word.startsWith("--")) break
    const separator = word.indexOf("=")
    if (separator === -1) flags.set(word.slice(2), "")
    else flags.set(word.slice(2, separator), word.slice(separator + 1))
  }

  return { flags, rest: [...words.slice(index)] }
}

/** Parse the JSON-array (exec) form, returning undefined when it is not one. */
export const parseExecForm = (args: string): string[] | undefined => {
  const trimmed = args.trim()
  if (!trimmed.startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed
  } catch {
    // Not valid JSON: Docker treats this as shell form, and so do we.
  }
  return undefined
}
