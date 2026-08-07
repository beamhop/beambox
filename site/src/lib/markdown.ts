import type { ReactNode } from "react"

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")

/** Heading text arrives as a React children tree; the id has to come from its text. */
export const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node !== null && typeof node === "object" && "props" in node) {
    const { props } = node as { props: { children?: ReactNode } }
    return textOf(props.children)
  }
  return ""
}

export interface TocEntry {
  readonly id: string
  readonly title: string
}

/**
 * The table of contents is read off the raw markdown rather than the rendered tree, so it
 * is available before the first paint and cannot drift out of document order.
 */
export const tableOfContents = (markdown: string): readonly TocEntry[] => {
  const entries: TocEntry[] = []
  let inFence = false

  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const heading = /^## (.+)$/.exec(line)
    if (heading?.[1] !== undefined) {
      const title = heading[1].replace(/`/g, "").trim()
      entries.push({ id: slugify(title), title })
    }
  }

  return entries
}

/**
 * The first `# Title` line, which the page renders as its own header instead — and the
 * README's own link back to this site, which is only useful when read on GitHub.
 */
export const stripTitle = (markdown: string): string =>
  markdown.replace(/^# .+\n+/, "").replace(/^\*\*\[Documentation →\]\([^)]*\)\*\*\n+/m, "")
