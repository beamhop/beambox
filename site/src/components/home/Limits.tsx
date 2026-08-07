import { LIMITS } from "../../content/site"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

export const Limits = () => (
  <Section id="limits">
    <Reveal>
      <Eyebrow>Known limits</Eyebrow>
      <SectionTitle>The four things it will not do.</SectionTitle>
      <Lead>
        Published up front rather than discovered in a build log at midnight. Each one is a
        deliberate trade, not an open bug.
      </Lead>
    </Reveal>

    <dl className="mt-14 divide-y divide-line/40 border-y border-line/40">
      {LIMITS.map((limit, i) => (
        <Reveal key={limit.title} delay={0.04 * i}>
          <div className="grid gap-3 py-7 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] md:gap-10">
            <dt className="flex gap-3 font-medium text-ink">
              <span className="font-mono text-sm text-ink-faint" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              {limit.title}
            </dt>
            <dd className="text-sm leading-relaxed text-ink-muted">{limit.body}</dd>
          </div>
        </Reveal>
      ))}
    </dl>
  </Section>
)
