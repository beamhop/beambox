import { Link } from "react-router-dom"
import { GITHUB_URL, INSTALL_COMMAND } from "../../content/site"
import { CopyButton } from "../CopyButton"
import ShinyText from "../reactbits/ShinyText"
import StarBorder from "../reactbits/StarBorder"
import { Reveal, Section } from "../Section"

export const CallToAction = () => (
  <Section className="relative overflow-hidden border-t border-line/40">
    <div
      className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-80 bg-[radial-gradient(ellipse_50%_100%_at_50%_100%,var(--color-beam)/0.16,transparent)]"
      aria-hidden="true"
    />
    <Reveal>
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-title font-semibold text-balance">
          <ShinyText
            text="Stop installing Docker to build images you never run in Docker."
            speed={6}
          />
        </h2>
        <p className="mt-6 text-lead text-ink-muted text-pretty">
          One dependency, a Dockerfile you already have, and a microVM that does the work.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <div className="flex items-center gap-3 rounded-pill border border-line/70 bg-base/70 py-2 pr-2 pl-5 font-mono text-sm">
            <span className="text-beam/70 select-none">$</span>
            <span className="text-ink">{INSTALL_COMMAND}</span>
            <CopyButton value={INSTALL_COMMAND} className="rounded-pill" />
          </div>

          <StarBorder
            as={Link}
            to="/docs/overview"
            color="#c4a2fc"
            speed="5s"
            className="text-sm font-medium"
          >
            <span className="block rounded-[20px] bg-surface px-6 py-3 text-ink">
              Documentation
            </span>
          </StarBorder>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-pill px-5 py-3 text-sm text-ink-muted transition-colors duration-(--duration-quick) hover:text-ink"
          >
            View source →
          </a>
        </div>
      </div>
    </Reveal>
  </Section>
)
