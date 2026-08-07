import { CodeBlock } from "../CodeBlock"
import CountUp from "../reactbits/CountUp"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

const DOCKER_WAY = `docker build -t my-image:latest .
docker save my-image:latest | msb load`

const BEAM_WAY = `beambox build -t my-image:latest .
msb run my-image:latest`

const STATS = [
  { value: 0, suffix: "", label: "daemons to run" },
  { value: 0, suffix: "", label: "root privileges needed" },
  { value: 6, suffix: "", label: "focused packages" },
  { value: 16, suffix: "", label: "Dockerfile instructions" },
] as const

export const TheGap = () => (
  <Section id="why" className="relative">
    <div className="grid-veil pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

    <Reveal>
      <Eyebrow>The gap</Eyebrow>
      <SectionTitle>
        microsandbox replaces Docker at runtime — and then asks you to install Docker.
      </SectionTitle>
      <Lead>
        microsandbox runs standard OCI images as microVM root filesystems, but it ships no image
        builder. Its own documentation tells you to reach for the tool it exists to replace. beambox
        closes that gap.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-6 lg:grid-cols-2">
      <Reveal delay={0.05}>
        <div className="h-full rounded-card border border-danger/20 bg-danger/[0.04] p-5">
          <p className="mb-4 flex items-center gap-2 font-mono text-xs tracking-widest text-danger/90 uppercase">
            <span aria-hidden="true">✕</span> what the docs tell you to do
          </p>
          <CodeBlock code={DOCKER_WAY} lang="bash" title="requires a Docker daemon" />
        </div>
      </Reveal>

      <Reveal delay={0.12}>
        <div className="h-full rounded-card border border-beam/25 bg-beam/[0.05] p-5">
          <p className="mb-4 flex items-center gap-2 font-mono text-xs tracking-widest text-beam uppercase">
            <span aria-hidden="true">→</span> with beambox
          </p>
          <CodeBlock code={BEAM_WAY} lang="bash" title="requires nothing but bun" />
        </div>
      </Reveal>
    </div>

    <Reveal delay={0.1}>
      <dl className="mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line/50 bg-line/40 sm:grid-cols-4">
        {STATS.map((stat) => (
          <div key={stat.label} className="bg-base/70 px-6 py-8">
            <dt className="sr-only">{stat.label}</dt>
            <dd>
              <span className="block text-4xl font-semibold tracking-tight text-ink">
                <CountUp to={stat.value} duration={1.4} />
                {stat.suffix}
              </span>
              <span className="mt-2 block text-sm text-ink-muted">{stat.label}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Reveal>
  </Section>
)
