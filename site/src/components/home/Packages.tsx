import { Link } from "react-router-dom"
import { PACKAGES } from "../../content/site"
import SpotlightCard from "../reactbits/SpotlightCard"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

export const Packages = () => (
  <Section id="packages" className="border-y border-line/40 bg-base/30">
    <Reveal>
      <Eyebrow>Packages</Eyebrow>
      <SectionTitle>Six packages, one dependency you actually install.</SectionTitle>
      <Lead>
        <code className="font-mono text-ink">@beambox/builder</code> never imports microsandbox. The
        runtime dependency exists only where a <code className="font-mono text-ink">RUN</code> step
        actually needs it.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {PACKAGES.map((pkg, i) => (
        <Reveal key={pkg.name} delay={0.05 * (i % 3)}>
          <Link to={`/docs/${pkg.slug}`} className="block h-full">
            <SpotlightCard
              className="group h-full rounded-card! border-line/60! bg-base/60! p-7! transition-colors duration-(--duration-base) hover:border-beam/40!"
              spotlightColor="rgba(167, 139, 250, 0.14)"
            >
              <h3 className="font-mono text-sm font-medium text-beam">{pkg.name}</h3>
              <p className="mt-4 text-sm leading-relaxed text-ink-muted">{pkg.summary}</p>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors group-hover:text-ink">
                Read the docs
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
