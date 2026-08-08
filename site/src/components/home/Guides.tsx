import { Link } from "react-router-dom"
import { GUIDES } from "../../content/site"
import SpotlightCard from "../reactbits/SpotlightCard"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

export const Guides = () => (
  <Section id="guides">
    <Reveal>
      <Eyebrow>Guides</Eyebrow>
      <SectionTitle>Start to finish, whichever way you build.</SectionTitle>
      <Lead>
        Three step-by-step walkthroughs — the shell, the API, and the agent that does it for you.
        Each one ends with a running microVM rather than a built artefact nobody started.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-5 lg:grid-cols-3">
      {GUIDES.map((guide, i) => (
        <Reveal key={guide.slug} delay={0.05 * i}>
          <Link to={`/docs/${guide.slug}`} className="block h-full">
            <SpotlightCard
              className="group h-full rounded-card! border-line/60! bg-base/60! p-7! transition-colors duration-(--duration-base) hover:border-beam/40!"
              spotlightColor="rgba(167, 139, 250, 0.14)"
            >
              <h3 className="text-lg font-semibold text-ink">{guide.title}</h3>
              {/* The first command of the guide: what step one actually looks like. */}
              <p className="mt-4 overflow-x-auto rounded-lg border border-line/50 bg-surface/40 px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-beam/90">
                {guide.command}
              </p>
              <p className="mt-4 text-sm leading-relaxed text-ink-muted">{guide.summary}</p>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors group-hover:text-ink">
                Read the guide
                <span
                  aria-hidden="true"
                  className="transition-transform duration-(--duration-quick) group-hover:translate-x-0.5"
                >
                  →
                </span>
              </span>
            </SpotlightCard>
          </Link>
        </Reveal>
      ))}
    </div>
  </Section>
)
