import { lazy, Suspense } from "react"
import { Link } from "react-router-dom"
import { GITHUB_URL, INSTALL_COMMAND, VERSION } from "../content/site"
import { CopyButton } from "./CopyButton"
import ShinyText from "./reactbits/ShinyText"
import SplitText from "./reactbits/SplitText"
import StarBorder from "./reactbits/StarBorder"
import TextType from "./reactbits/TextType"

/* three.js is a megabyte the first paint should not wait for. */
const Beams = lazy(() => import("./reactbits/Beams"))

const TERMINAL_LINES = [
  "beambox build -t my-app:local .",
  "msb run my-app:local",
  "beambox build -t ghcr.io/me/app:v1 --push .",
]

export const Hero = () => (
  <div className="relative isolate overflow-hidden">
    {/* The beams are decoration only; everything above them is real text. */}
    <div className="absolute inset-0 -z-10" aria-hidden="true">
      <Suspense
        fallback={
          <div className="size-full bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,var(--color-beam)/0.14,transparent_70%)]" />
        }
      >
        <Beams
          beamWidth={2.4}
          beamHeight={22}
          beamNumber={14}
          lightColor="#8fe6ff"
          speed={1.6}
          noiseIntensity={1.5}
          scale={0.22}
          rotation={38}
        />
      </Suspense>
    </div>
    <div
      className="absolute inset-0 -z-10 bg-gradient-to-b from-void/40 via-void/60 to-void"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-6xl px-gutter pt-24 pb-section sm:pt-32">
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2.5 rounded-pill border border-line/70 bg-base/60 py-1.5 pr-4 pl-1.5 text-sm text-ink-muted backdrop-blur transition-colors duration-(--duration-quick) hover:border-beam/40 hover:text-ink"
      >
        <span className="rounded-pill bg-beam/15 px-2.5 py-0.5 font-mono text-[11px] text-beam">
          v{VERSION}
        </span>
        <ShinyText text="Docker is no longer a prerequisite" speed={4} className="text-sm" />
      </a>

      <SplitText
        tag="h1"
        text="Build OCI images without Docker."
        className="mt-8 max-w-4xl text-hero font-bold text-balance"
        splitType="words"
        delay={40}
        duration={0.9}
        ease="power4.out"
        from={{ opacity: 0, y: 40, filter: "blur(8px)" }}
        to={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      />

      <p className="mt-7 max-w-2xl text-lead text-ink-muted text-pretty">
        beambox builds images for{" "}
        <a
          href="https://microsandbox.dev"
          target="_blank"
          rel="noreferrer"
          className="text-ink underline decoration-beam/40 underline-offset-4 transition-colors hover:decoration-beam"
        >
          microsandbox
        </a>{" "}
        in pure TypeScript. It pulls base images, executes <code className="font-mono">RUN</code>{" "}
        steps inside a microVM, assembles layers, and hands the result over — with no daemon, no
        root, and nothing native to install.
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <StarBorder
          as={Link}
          to="/docs/overview"
          color="#67e8f9"
          speed="5s"
          className="text-sm font-medium"
        >
          <span className="block rounded-[20px] bg-surface px-6 py-3 text-ink">Read the docs</span>
        </StarBorder>

        <div className="flex items-center gap-3 rounded-pill border border-line/70 bg-base/70 py-2 pr-2 pl-5 font-mono text-sm backdrop-blur">
          <span className="text-beam/70 select-none">$</span>
          <span className="text-ink">{INSTALL_COMMAND}</span>
          <CopyButton value={INSTALL_COMMAND} className="rounded-pill" />
        </div>
      </div>

      <div className="mt-16 max-w-2xl overflow-hidden rounded-card border border-line/60 bg-base/70 shadow-glow backdrop-blur-md">
        <div className="flex items-center gap-3 border-b border-line/50 bg-surface/40 px-4 py-2.5">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-danger/70" />
            <span className="size-2.5 rounded-full bg-signal/70" />
            <span className="size-2.5 rounded-full bg-go/70" />
          </span>
          <span className="font-mono text-[11px] text-ink-faint">zsh — no Docker installed</span>
        </div>
        <div className="px-5 py-6 font-mono text-sm leading-loose">
          <span className="mr-2 text-beam/70 select-none">$</span>
          <TextType
            as="span"
            text={TERMINAL_LINES}
            typingSpeed={45}
            deletingSpeed={22}
            pauseDuration={2600}
            loop
            className="text-ink"
            cursorCharacter="▌"
            cursorClassName="text-beam"
          />
        </div>
      </div>
    </div>
  </div>
)
