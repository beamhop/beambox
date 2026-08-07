import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { GITHUB_URL, NPM_URL } from "../content/site"
import { BeamMark } from "./BeamMark"

const LINKS = [
  { href: "/#install", label: "Install" },
  { href: "/docs/overview", label: "Docs" },
  { href: "/docs/beambox", label: "API" },
  { href: "/#packages", label: "Packages" },
] as const

export const SiteNav = () => {
  const { pathname, hash } = useLocation()
  const [lifted, setLifted] = useState(false)

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const current = `${pathname}${hash}`

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors duration-(--duration-base) ${
        lifted ? "border-line/50 bg-void/80 backdrop-blur-xl" : "border-transparent bg-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-gutter">
        <Link
          to="/"
          className="mr-auto flex items-center gap-2.5 font-semibold tracking-tight text-ink"
        >
          <BeamMark className="size-7" />
          beambox
        </Link>

        <ul className="hidden items-center gap-1 sm:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                to={link.href}
                className={`rounded-pill px-3.5 py-2 text-sm transition-colors duration-(--duration-quick) hover:bg-surface/70 hover:text-ink ${
                  current.startsWith(link.href) ? "text-ink" : "text-ink-muted"
                }`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <a
          href={NPM_URL}
          target="_blank"
          rel="noreferrer"
          className="hidden rounded-pill px-3.5 py-2 text-sm text-ink-muted transition-colors duration-(--duration-quick) hover:bg-surface/70 hover:text-ink md:block"
        >
          npm
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-1 flex items-center gap-2 rounded-pill border border-line/70 bg-surface/60 px-3.5 py-2 text-sm text-ink-muted transition-colors duration-(--duration-quick) hover:border-beam/40 hover:text-ink"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub
        </a>
      </nav>
    </header>
  )
}
