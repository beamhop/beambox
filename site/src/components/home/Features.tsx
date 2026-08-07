import { FEATURES } from "../../content/site"
import SpotlightCard from "../reactbits/SpotlightCard"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

export const Features = () => (
  <Section id="features" className="border-y border-line/40 bg-base/30">
    <Reveal>
      <Eyebrow>What you get</Eyebrow>
      <SectionTitle>Boring where it counts, strict where it matters.</SectionTitle>
      <Lead>
        The registry tests run a real, spec-conformant OCI registry in process rather than a mock,
        and the e2e suite proves every claim by booting the finished image and reading what it
        prints.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map((feature, i) => (
        <Reveal key={feature.title} delay={0.05 * (i % 3)}>
          <SpotlightCard
            /* The vendored card ships its own neutral skin; ours has to win. */
            className="h-full rounded-card! border-line/60! bg-base/60! p-7!"
            spotlightColor="rgba(103, 232, 249, 0.12)"
          >
            <span className="font-mono text-2xl text-beam" aria-hidden="true">
              {feature.glyph}
            </span>
            <h3 className="mt-5 text-lg font-semibold text-ink">{feature.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{feature.body}</p>
          </SpotlightCard>
        </Reveal>
      ))}
    </div>
  </Section>
)
