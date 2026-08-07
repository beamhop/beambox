import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

interface Step {
  readonly index: string
  readonly title: string
  readonly body: string
}

const STEPS: readonly Step[] = [
  {
    index: "01",
    title: "Load the work-in-progress image",
    body: "For each stage, the image built so far is loaded into the microsandbox cache — the same path a finished image takes.",
  },
  {
    index: "02",
    title: "Boot it as a microVM",
    body: "A statically linked busybox is bind-mounted in from the host, pulled through beambox's own registry client. The guest needs no shell, tar, or find of its own.",
  },
  {
    index: "03",
    title: "Index, execute, index again",
    body: "The guest root filesystem is indexed before and after the step. The layer is the difference between the two snapshots.",
  },
  {
    index: "04",
    title: "Turn deletions into whiteouts",
    body: "Paths that disappeared become OCI .wh. entries, so rm inside a RUN behaves exactly as it does under Docker.",
  },
]

export const HowRunWorks = () => (
  <Section id="how" className="border-y border-line/40 bg-base/30">
    <Reveal>
      <Eyebrow>How RUN works</Eyebrow>
      <SectionTitle>microsandbox becomes its own build engine.</SectionTitle>
      <Lead>
        There is no shadow container runtime hiding under beambox. The thing that runs your image is
        the thing that builds it.
      </Lead>
    </Reveal>

    <ol className="mt-14 grid gap-5 md:grid-cols-2">
      {STEPS.map((step, i) => (
        <Reveal key={step.index} delay={0.06 * i}>
          <li className="group relative h-full overflow-hidden rounded-card border border-line/60 bg-base/60 p-7">
            <span
              className="absolute -top-3 -right-1 font-mono text-7xl font-bold text-line/40 transition-colors duration-(--duration-base) group-hover:text-beam/20"
              aria-hidden="true"
            >
              {step.index}
            </span>
            <h3 className="relative max-w-[22ch] text-lg font-semibold text-ink">{step.title}</h3>
            <p className="relative mt-3 text-sm leading-relaxed text-ink-muted">{step.body}</p>
          </li>
        </Reveal>
      ))}
    </ol>

    <Reveal delay={0.08}>
      <p className="mt-10 flex items-start gap-3 rounded-card border border-beam/20 bg-beam/[0.04] p-6 text-sm leading-relaxed text-ink-muted">
        <span className="mt-0.5 font-mono text-beam" aria-hidden="true">
          ⚡
        </span>
        <span>
          A build with <strong className="font-semibold text-ink">no RUN steps</strong> never boots
          a VM and never loads the microsandbox SDK. Purely declarative builds work anywhere, with
          nothing installed at all — and can target any platform, because nothing is executed.
        </span>
      </p>
    </Reveal>
  </Section>
)
