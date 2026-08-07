import { REFUSED_INSTRUCTIONS, SUPPORTED_EXTRAS, SUPPORTED_INSTRUCTIONS } from "../../content/site"
import { CodeBlock } from "../CodeBlock"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

/* The exact text UnsupportedInstructionError produces for ONBUILD. */
const REFUSAL = `UnsupportedInstructionError [DOCKERFILE_UNSUPPORTED]

  Dockerfile line 7: ONBUILD is not supported. Triggers that
  fire in a downstream build have no equivalent here. Move the
  work into the downstream Dockerfile.`

export const DockerfileSupport = () => (
  <Section id="dockerfile">
    <Reveal>
      <Eyebrow>Dockerfile support</Eyebrow>
      <SectionTitle>Refused by name and line number, never silently skipped.</SectionTitle>
      <Lead>
        An instruction that quietly does nothing produces an image that looks right and behaves
        wrong, which is worse than a build that stops and explains.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <Reveal delay={0.05}>
        <div className="h-full rounded-card border border-line/60 bg-base/50 p-7">
          <h3 className="flex items-center gap-2 font-mono text-xs tracking-widest text-go uppercase">
            <span aria-hidden="true">✓</span> supported
          </h3>
          <ul className="mt-5 flex flex-wrap gap-2">
            {SUPPORTED_INSTRUCTIONS.map((name) => (
              <li
                key={name}
                className="rounded-md border border-go/25 bg-go/[0.07] px-2.5 py-1 font-mono text-xs text-ink"
              >
                {name}
              </li>
            ))}
          </ul>
          <ul className="mt-4 flex flex-wrap gap-2">
            {SUPPORTED_EXTRAS.map((name) => (
              <li
                key={name}
                className="rounded-md border border-line/60 bg-surface/50 px-2.5 py-1 font-mono text-xs text-ink-muted"
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      </Reveal>

      <Reveal delay={0.12}>
        <div className="flex h-full flex-col gap-5">
          <div className="rounded-card border border-line/60 bg-base/50 p-7">
            <h3 className="flex items-center gap-2 font-mono text-xs tracking-widest text-danger uppercase">
              <span aria-hidden="true">✕</span> refused, loudly
            </h3>
            <ul className="mt-5 flex flex-wrap gap-2">
              {REFUSED_INSTRUCTIONS.map((name) => (
                <li
                  key={name}
                  className="rounded-md border border-danger/25 bg-danger/[0.06] px-2.5 py-1 font-mono text-xs text-ink-muted"
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
          <CodeBlock code={REFUSAL} lang="text" title="what a refusal looks like" />
        </div>
      </Reveal>
    </div>
  </Section>
)
