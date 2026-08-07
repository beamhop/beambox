import { Link } from "react-router-dom"

export const NotFound = () => (
  <div className="mx-auto flex max-w-2xl flex-col items-start px-gutter py-section">
    <p className="font-mono text-xs tracking-widest text-beam uppercase">404</p>
    <h1 className="mt-4 text-title font-semibold tracking-tight">
      No layer here — this path was whited out.
    </h1>
    <p className="mt-5 text-lead text-ink-muted">
      The page you asked for is not in this image. Try the documentation index instead.
    </p>
    <div className="mt-8 flex gap-4">
      <Link
        to="/docs/overview"
        className="rounded-pill border border-beam/40 bg-beam/10 px-5 py-2.5 text-sm text-beam transition-colors duration-(--duration-quick) hover:bg-beam/15"
      >
        Documentation
      </Link>
      <Link
        to="/"
        className="rounded-pill border border-line/60 px-5 py-2.5 text-sm text-ink-muted transition-colors duration-(--duration-quick) hover:text-ink"
      >
        Home
      </Link>
    </div>
  </div>
)
