import { NavLink, Outlet } from "react-router-dom"
import { DOC_PAGES, type DocSection } from "../content/docs"

/** Declared rather than derived, so the sidebar order never depends on page order. */
const SECTIONS: readonly DocSection[] = ["Start here", "Guides", "Reference"]

export const DocsLayout = () => (
  /* Wider than the landing page: prose plus a sidebar plus a table of contents, and code
     samples that should not have to scroll horizontally to be read. */
  <div className="mx-auto grid max-w-7xl gap-10 px-gutter py-16 lg:grid-cols-[14rem_minmax(0,1fr)]">
    <nav aria-label="Documentation" className="lg:sticky lg:top-24 lg:self-start">
      <h2 className="font-mono text-xs tracking-widest text-ink-faint uppercase">Documentation</h2>

      {/* One horizontal scroller on small screens, three stacked groups from lg up. */}
      <div className="mt-5 flex snap-x gap-6 overflow-x-auto pb-2 lg:flex-col lg:gap-7 lg:overflow-visible lg:pb-0">
        {SECTIONS.map((section) => (
          <section key={section} className="shrink-0 lg:shrink">
            <h3 className="mb-2 font-mono text-[10px] tracking-widest text-ink-faint/70 uppercase">
              {section}
            </h3>
            <ul className="flex gap-2 lg:flex-col lg:gap-1">
              {DOC_PAGES.filter((page) => page.section === section).map((page) => (
                <li key={page.slug} className="shrink-0 snap-start lg:shrink">
                  <NavLink
                    to={`/docs/${page.slug}`}
                    className={({ isActive }) =>
                      `block rounded-lg border px-3.5 py-2 text-sm transition-colors duration-(--duration-quick) lg:border-0 lg:border-l-2 lg:px-4 lg:whitespace-normal ${
                        isActive
                          ? "border-beam/40 bg-beam/10 text-ink lg:border-l-beam lg:bg-transparent"
                          : "border-line/50 text-ink-muted hover:text-ink lg:border-l-line/50 lg:hover:border-l-line"
                      }`
                    }
                  >
                    <span className="block whitespace-nowrap lg:whitespace-normal">
                      {page.title}
                    </span>
                    <span className="hidden font-mono text-[11px] text-ink-faint lg:block">
                      {page.pkg}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>

    <Outlet />
  </div>
)
