import { useEffect, useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { Markdown } from "../components/Markdown"
import { DOC_PAGES, findDoc } from "../content/docs"
import { editUrl } from "../content/site"
import { stripTitle, tableOfContents } from "../lib/markdown"
import { NotFound } from "./NotFound"

export const DocPageView = () => {
  const { slug } = useParams()
  const page = findDoc(slug)

  const toc = useMemo(() => (page ? tableOfContents(page.markdown) : []), [page])
  const body = useMemo(() => (page ? stripTitle(page.markdown) : ""), [page])

  useEffect(() => {
    if (page) document.title = `${page.title} — beambox`
    return () => {
      document.title = "beambox — build OCI images without Docker"
    }
  }, [page])

  if (!page) return <NotFound />

  const index = DOC_PAGES.findIndex((entry) => entry.slug === page.slug)
  const previous = index > 0 ? DOC_PAGES[index - 1] : undefined
  const next = DOC_PAGES[index + 1]

  return (
    <div className="grid min-w-0 gap-12 xl:grid-cols-[minmax(0,1fr)_13rem]">
      <article className="min-w-0">
        <p className="font-mono text-xs tracking-widest text-beam uppercase">{page.pkg}</p>
        <h1 className="mt-4 text-title font-semibold tracking-tight text-balance">{page.title}</h1>
        <p className="mt-4 max-w-2xl text-lead text-ink-muted text-pretty">{page.blurb}</p>
        <div className="beam-rule mt-8 h-px" aria-hidden="true" />

        <div className="mt-2">
          <Markdown>{body}</Markdown>
        </div>

        <nav className="mt-20 flex flex-wrap gap-4 border-t border-line/40 pt-8">
          {previous ? (
            <Link
              to={`/docs/${previous.slug}`}
              className="rounded-card border border-line/60 px-5 py-4 transition-colors duration-(--duration-quick) hover:border-beam/40"
            >
              <span className="block font-mono text-[11px] text-ink-faint">← previous</span>
              <span className="mt-1 block text-sm text-ink">{previous.title}</span>
            </Link>
          ) : null}
          {next ? (
            <Link
              to={`/docs/${next.slug}`}
              className="ml-auto rounded-card border border-line/60 px-5 py-4 text-right transition-colors duration-(--duration-quick) hover:border-beam/40"
            >
              <span className="block font-mono text-[11px] text-ink-faint">next →</span>
              <span className="mt-1 block text-sm text-ink">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>

      <aside className="hidden xl:sticky xl:top-24 xl:block xl:self-start">
        <h2 className="font-mono text-xs tracking-widest text-ink-faint uppercase">On this page</h2>
        <ul className="mt-5 space-y-2.5 border-l border-line/50 text-sm">
          {toc.map((entry) => (
            <li key={entry.id}>
              <a
                href={`#${entry.id}`}
                className="-ml-px block border-l border-transparent pl-4 text-ink-muted transition-colors duration-(--duration-quick) hover:border-beam hover:text-ink"
              >
                {entry.title}
              </a>
            </li>
          ))}
        </ul>
        <a
          href={editUrl(page.source)}
          target="_blank"
          rel="noreferrer"
          className="mt-8 block pl-4 font-mono text-[11px] text-ink-faint transition-colors hover:text-beam"
        >
          edit on GitHub ↗
        </a>
      </aside>
    </div>
  )
}
