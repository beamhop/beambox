import { Link } from "react-router-dom"
import { DOC_PAGES } from "../content/docs"
import { GITHUB_URL, MICROSANDBOX_URL, NPM_URL, REACT_BITS_URL } from "../content/site"
import { BeamMark } from "./BeamMark"

export const SiteFooter = () => (
  <footer className="border-t border-line/50 bg-base/40">
    <div className="mx-auto grid max-w-6xl gap-10 px-gutter py-16 sm:grid-cols-2 lg:grid-cols-4">
      <div className="lg:col-span-2">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <BeamMark className="size-7" />
          beambox
        </div>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-muted">
          Build OCI images for microsandbox without Docker. No daemon, no root, no native
          dependencies — just TypeScript.
        </p>
        <p className="mt-6 font-mono text-xs text-ink-faint">MIT licensed</p>
      </div>

      <nav aria-label="Documentation">
        <h2 className="font-mono text-xs tracking-widest text-ink-faint uppercase">Docs</h2>
        <ul className="mt-4 space-y-2.5 text-sm">
          {DOC_PAGES.map((page) => (
            <li key={page.slug}>
              <Link
                to={`/docs/${page.slug}`}
                className="text-ink-muted transition-colors duration-(--duration-quick) hover:text-beam"
              >
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label="Elsewhere">
        <h2 className="font-mono text-xs tracking-widest text-ink-faint uppercase">Elsewhere</h2>
        <ul className="mt-4 space-y-2.5 text-sm">
          {[
            { href: GITHUB_URL, label: "GitHub" },
            { href: NPM_URL, label: "npm" },
            { href: MICROSANDBOX_URL, label: "microsandbox" },
            { href: REACT_BITS_URL, label: "Built with React Bits" },
          ].map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-ink-muted transition-colors duration-(--duration-quick) hover:text-beam"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  </footer>
)
