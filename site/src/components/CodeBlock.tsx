import { useEffect, useState } from "react"
import { highlight, type Language } from "../lib/highlighter"
import { CopyButton } from "./CopyButton"

interface CodeBlockProps {
  readonly code: string
  readonly lang: Language
  /** Rendered as a tab in the block's chrome — a filename, or a shell prompt label. */
  readonly title?: string
  readonly className?: string
}

export const CodeBlock = ({ code, lang, title, className = "" }: CodeBlockProps) => {
  const [html, setHtml] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    void highlight(code, lang).then((result) => {
      if (live) setHtml(result)
    })
    return () => {
      live = false
    }
  }, [code, lang])

  return (
    <figure
      className={`group relative overflow-hidden rounded-card border border-line/60 bg-base/80 shadow-card backdrop-blur-sm ${className}`}
    >
      <figcaption className="flex items-center gap-3 border-b border-line/50 bg-surface/50 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-danger/70" />
          <span className="size-2.5 rounded-full bg-signal/70" />
          <span className="size-2.5 rounded-full bg-go/70" />
        </span>
        <span className="truncate font-mono text-[11px] text-ink-faint">{title ?? lang}</span>
        <CopyButton
          value={code}
          className="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        />
      </figcaption>
      {html === undefined ? (
        <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-ink-muted">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="[&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki markup built from repository source that ships with the site — no user-supplied input reaches this.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </figure>
  )
}
