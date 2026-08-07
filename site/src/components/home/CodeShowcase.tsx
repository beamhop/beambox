import { useState } from "react"
import type { Language } from "../../lib/highlighter"
import { CodeBlock } from "../CodeBlock"
import { Eyebrow, Lead, Reveal, Section, SectionTitle } from "../Section"

interface Sample {
  readonly id: string
  readonly tab: string
  readonly title: string
  readonly note: string
  readonly lang: Language
  readonly code: string
}

/* Named separately so the default tab needs no index lookup and no cast. */
const FLUENT: Sample = {
  id: "fluent",
  tab: "Fluent API",
  title: "build.ts",
  note: "Every method returns a new spec, so specs can be shared and branched without a later call reaching back and changing an earlier result.",
  lang: "ts",
  code: `import { image } from "beambox"

const base = image("node:22-slim")
  .workdir("/app")
  .env({ NODE_ENV: "production" })

// \`base\` is unchanged by either of these.
const api = base.copy("./api/dist", "/app").cmd(["node", "index.js"])
const worker = base.copy("./worker/dist", "/app").cmd(["node", "worker.js"])

const built = await api.build({ tags: ["api:local"] })
await built.load()`,
}

const SAMPLES: readonly Sample[] = [
  FLUENT,
  {
    id: "multi-stage",
    tab: "Multi-stage",
    title: "release.ts",
    note: "A cache mount becomes a microsandbox named volume: the npm cache survives between builds, and because it is its own filesystem, nothing in it ends up in the image.",
    lang: "ts",
    code: `const built = await image("node:22", { as: "builder" })
  .workdir("/src")
  .copy(["package.json", "package-lock.json"], "./")
  .run("npm ci", { mounts: [{ type: "cache", target: "/root/.npm", id: "npm" }] })
  .copy(".", ".")
  .run("npm run build")
  .stage("node:22-slim")
  .copy("/src/dist", "/app", { from: "builder" })
  .workdir("/app")
  .expose(3000)
  .cmd(["node", "index.js"])
  .build({ tags: ["app:local"] })

await built.load()`,
  },
  {
    id: "dockerfile",
    tab: "Dockerfile",
    title: "from-dockerfile.ts",
    note: "The Dockerfile front-end lowers onto the same build engine. dockerfileText does the same with a string, which is handy in tests.",
    lang: "ts",
    code: `import { dockerfile } from "beambox"

const source = await dockerfile("./Dockerfile", { context: "." })

const built = await source.build({
  tags: ["app:local"],
  buildArgs: { VERSION: "1.2.3" },
  onProgress: (event) => {
    if (event.kind === "step") console.log(event.instruction)
  },
})

await built.load()`,
  },
  {
    id: "outputs",
    tab: "Outputs",
    title: "outputs.ts",
    note: "A BuiltImage is also a plain ImageArtifact, so built.config, built.manifest, and built.layers are all there to inspect.",
    lang: "ts",
    code: `const built = await image("alpine:3.20")
  .cmd(["/bin/sh"])
  .build({ tags: ["demo:local"] })

await built.load()                                       // microsandbox cache
await built.toArchive("demo.tar")                        // docker save format
await built.toArchive("demo.oci.tar", { format: "oci" }) // OCI Image Layout
await built.toLayoutDirectory("./out/oci")               // unpacked, for skopeo/crane
await built.push("ghcr.io/me/demo:v1")                   // any OCI registry`,
  },
  {
    id: "errors",
    tab: "Errors",
    title: "errors.ts",
    note: "DockerfileParseError, UnsupportedInstructionError, RunFailedError, NoExecutorError, PlatformMismatchError, CopySourceError, UnknownStageError, RegistryAuthError.",
    lang: "ts",
    code: `import { RunFailedError } from "beambox"

try {
  await image("alpine").run("exit 42").build()
} catch (error) {
  if (error instanceof RunFailedError) {
    console.error(error.exitCode) // 42
    console.error(error.output)   // everything the step printed
  }
}`,
  },
]

export const CodeShowcase = () => {
  const [active, setActive] = useState(FLUENT.id)
  const sample = SAMPLES.find((entry) => entry.id === active) ?? FLUENT

  return (
    <Section id="api">
      <Reveal>
        <Eyebrow>The API</Eyebrow>
        <SectionTitle>An immutable spec, and one way to run it.</SectionTitle>
        <Lead>
          The same engine backs the fluent API, the Dockerfile front-end, and the{" "}
          <code className="font-mono text-ink">beam</code> CLI.
        </Lead>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <div role="tablist" aria-label="Code examples" className="mb-4 flex flex-wrap gap-2">
              {SAMPLES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={entry.id === sample.id}
                  onClick={() => setActive(entry.id)}
                  className={`cursor-pointer rounded-pill border px-4 py-1.5 font-mono text-xs transition-colors duration-(--duration-quick) ${
                    entry.id === sample.id
                      ? "border-beam/50 bg-beam/10 text-beam"
                      : "border-line/60 bg-surface/40 text-ink-muted hover:border-line hover:text-ink"
                  }`}
                >
                  {entry.tab}
                </button>
              ))}
            </div>
            <CodeBlock code={sample.code} lang={sample.lang} title={sample.title} />
          </div>

          <aside className="self-start rounded-card border border-line/60 bg-base/50 p-6 lg:sticky lg:top-24">
            <h3 className="font-mono text-xs tracking-widest text-ink-faint uppercase">
              {sample.tab}
            </h3>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">{sample.note}</p>
          </aside>
        </div>
      </Reveal>
    </Section>
  )
}
