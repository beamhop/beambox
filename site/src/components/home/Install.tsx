import { INSTALL_ROUTES } from "../../content/site"
import { CopyButton } from "../CopyButton"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

export const Install = () => (
  <Section id="install">
    <Reveal>
      <Eyebrow>Install</Eyebrow>
      <SectionTitle>Three ways in, depending on what you want.</SectionTitle>
      <Lead>
        Runs on Node 20+ and on Bun. <code className="font-mono text-ink">RUN</code> steps
        additionally need the microsandbox runtime; declarative builds need nothing at all.
      </Lead>
    </Reveal>

    <div className="mt-14 grid gap-5 lg:grid-cols-3">
      {INSTALL_ROUTES.map((route, i) => (
        <Reveal key={route.title} delay={0.05 * i}>
          <div className="flex h-full flex-col rounded-card border border-line/60 bg-base/50 p-7">
            <h3 className="text-lg font-semibold text-ink">{route.title}</h3>

            <ul className="mt-5 space-y-2.5">
              {route.commands.map((command, index) => (
                <li
                  key={command}
                  className={`flex items-start gap-3 rounded-lg border px-4 py-2.5 font-mono text-[13px] ${
                    index === 0 ? "border-beam/30 bg-beam/[0.06]" : "border-line/50 bg-surface/40"
                  }`}
                >
                  <span className="shrink-0 text-beam/70 select-none">$</span>
                  {/* Wrap rather than truncate: an unreadable command defeats the section. */}
                  <code className="min-w-0 flex-1 break-words text-ink">{command}</code>
                  {/* Always visible — hover-to-reveal is unreachable on touch. */}
                  <CopyButton value={command} className="shrink-0" />
                </li>
              ))}
            </ul>

            <p className="mt-5 text-sm leading-relaxed text-ink-muted">{route.note}</p>
          </div>
        </Reveal>
      ))}
    </div>
  </Section>
)
