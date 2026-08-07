import { isValidElement, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { Link } from "react-router-dom"
import remarkGfm from "remark-gfm"
import { resolveDocLink } from "../content/docs"
import { toLanguage } from "../lib/highlighter"
import { slugify, textOf } from "../lib/markdown"
import { CodeBlock } from "./CodeBlock"

/** `pre > code.language-x` is the only shape a fenced block takes in the README sources. */
const fencedCode = (
  children: ReactNode,
): { code: string; lang: string | undefined } | undefined => {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return undefined
  const language = /language-(\w+)/.exec(children.props.className ?? "")?.[1]
  return { code: textOf(children.props.children).replace(/\n$/, ""), lang: language }
}

const heading =
  (level: 2 | 3 | 4) =>
  ({ children }: { children?: ReactNode }) => {
    const id = slugify(textOf(children))
    const Tag = `h${level}` as const
    const size =
      level === 2
        ? "mt-16 mb-5 scroll-mt-24 text-2xl font-semibold tracking-tight"
        : level === 3
          ? "mt-10 mb-4 scroll-mt-24 text-lg font-semibold"
          : "mt-8 mb-3 scroll-mt-24 text-base font-semibold"

    return (
      <Tag id={id} className={`group text-ink ${size}`}>
        <a href={`#${id}`} className="no-underline">
          {children}
          <span
            aria-hidden="true"
            className="ml-2 text-beam/0 transition-colors group-hover:text-beam/60"
          >
            #
          </span>
        </a>
      </Tag>
    )
  }

const COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="mt-14 mb-5 text-2xl font-semibold text-ink">{children}</h2>,
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  p: ({ children }) => <p className="my-5 leading-relaxed text-ink-muted">{children}</p>,
  ul: ({ children }) => <ul className="my-5 space-y-2.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-5 list-decimal space-y-2.5 pl-5">{children}</ol>,
  li: ({ children }) => (
    <li className="relative leading-relaxed text-ink-muted marker:text-ink-faint">{children}</li>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  hr: () => <hr className="my-12 border-line/50" />,
  blockquote: ({ children }) => (
    <blockquote className="my-6 border-l-2 border-beam/50 pl-5 text-ink-muted italic">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-7 overflow-x-auto rounded-card border border-line/60">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line/60 bg-surface/50 px-4 py-3 text-left font-medium text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line/30 px-4 py-3 align-top text-ink-muted">{children}</td>
  ),
  a: ({ href, children }) => {
    const target = resolveDocLink(href ?? "")
    const className =
      "text-ink underline decoration-beam/40 underline-offset-4 transition-colors hover:decoration-beam"

    return target.startsWith("/") ? (
      <Link to={target} className={className}>
        {children}
      </Link>
    ) : (
      <a href={target} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    )
  },
  code: ({ className, children }) => (
    <code
      className={`rounded border border-line/50 bg-surface/60 px-1.5 py-0.5 font-mono text-[0.85em] text-ink ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => {
    const fenced = fencedCode(children)
    if (!fenced) return <pre>{children}</pre>
    return (
      <CodeBlock
        code={fenced.code}
        lang={toLanguage(fenced.lang)}
        title={fenced.lang ?? "text"}
        className="my-7"
      />
    )
  },
}

interface MarkdownProps {
  readonly children: string
}

export const Markdown = ({ children }: MarkdownProps) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
    {children}
  </ReactMarkdown>
)
