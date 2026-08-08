import agentsGuide from "../../../docs/agents.md?raw"
import cliGuide from "../../../docs/cli.md?raw"
import libraryGuide from "../../../docs/library.md?raw"
import beamboxReadme from "../../../packages/beambox/README.md?raw"
import builderReadme from "../../../packages/builder/README.md?raw"
import dockerfileReadme from "../../../packages/dockerfile/README.md?raw"
import ociReadme from "../../../packages/oci/README.md?raw"
import registryReadme from "../../../packages/registry/README.md?raw"
import vmExecutorReadme from "../../../packages/vm-executor/README.md?raw"
import rootReadme from "../../../README.md?raw"

/** Sidebar grouping. Guides are read front to back; reference pages are looked up. */
export type DocSection = "Start here" | "Guides" | "Reference"

export interface DocPage {
  /** URL segment under /docs. */
  readonly slug: string
  /** Sidebar label. */
  readonly title: string
  /** npm name, or the guide's subject, shown in the sidebar and as the page kicker. */
  readonly pkg: string
  readonly section: DocSection
  readonly blurb: string
  /** Path within the repository, for the "edit this page" link. */
  readonly source: string
  readonly markdown: string
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "overview",
    title: "Overview",
    pkg: "@beamhop/beambox",
    section: "Start here",
    blurb: "Why beambox exists, how RUN works without Docker, and what it will not do.",
    source: "README.md",
    markdown: rootReadme,
  },
  {
    slug: "cli",
    title: "CLI guide",
    pkg: "beambox build",
    section: "Guides",
    blurb:
      "From an empty shell to msb run, step by step: install, build, run, and every place the image can go afterwards.",
    source: "docs/cli.md",
    markdown: cliGuide,
  },
  {
    slug: "library",
    title: "Library guide",
    pkg: "@beamhop/beambox",
    section: "Guides",
    blurb:
      "Build images from TypeScript: immutable specs, multi-stage, cache mounts, outputs, typed errors, and testing.",
    source: "docs/library.md",
    markdown: libraryGuide,
  },
  {
    slug: "agents",
    title: "Agent guide",
    pkg: "skills/beambox",
    section: "Guides",
    blurb:
      "Install the beambox skill so your coding agent builds microsandbox images instead of reaching for Docker.",
    source: "docs/agents.md",
    markdown: agentsGuide,
  },
  {
    slug: "beambox",
    title: "beambox",
    pkg: "@beamhop/beambox",
    section: "Reference",
    blurb: "The package you install: fluent API, Dockerfile front-end, and the beambox CLI.",
    source: "packages/beambox/README.md",
    markdown: beamboxReadme,
  },
  {
    slug: "oci",
    title: "OCI primitives",
    pkg: "@beamhop/oci",
    section: "Reference",
    blurb: "Digests, deterministic layer tars, manifests, and the three archive formats.",
    source: "packages/oci/README.md",
    markdown: ociReadme,
  },
  {
    slug: "registry",
    title: "Registry client",
    pkg: "@beamhop/registry",
    section: "Reference",
    blurb: "OCI Distribution v2 pull and push, in TypeScript, with no daemon.",
    source: "packages/registry/README.md",
    markdown: registryReadme,
  },
  {
    slug: "builder",
    title: "Build engine",
    pkg: "@beamhop/builder",
    section: "Reference",
    blurb: "Stages, layer assembly, caching, and the pluggable RUN executor interface.",
    source: "packages/builder/README.md",
    markdown: builderReadme,
  },
  {
    slug: "dockerfile",
    title: "Dockerfile",
    pkg: "@beamhop/dockerfile",
    section: "Reference",
    blurb: "Lexer, parser, typed AST, and the lowering onto the build engine.",
    source: "packages/dockerfile/README.md",
    markdown: dockerfileReadme,
  },
  {
    slug: "vm-executor",
    title: "vm-executor",
    pkg: "@beamhop/vm-executor",
    section: "Reference",
    blurb: "The microVM RUN executor, the layer diff, and the msb handoff.",
    source: "packages/vm-executor/README.md",
    markdown: vmExecutorReadme,
  },
]

export const findDoc = (slug: string | undefined): DocPage | undefined =>
  DOC_PAGES.find((page) => page.slug === slug)

/** Repository-relative links in the READMEs have no meaning once rendered on the site. */
const LINK_MAP: Readonly<Record<string, string>> = {
  "../../README.md": "/docs/overview",
  "packages/beambox": "/docs/beambox",
  "packages/oci": "/docs/oci",
  "packages/registry": "/docs/registry",
  "packages/builder": "/docs/builder",
  "packages/dockerfile": "/docs/dockerfile",
  "packages/vm-executor": "/docs/vm-executor",
  "../beambox": "/docs/beambox",
  "../oci": "/docs/oci",
  "../registry": "/docs/registry",
  "../builder": "/docs/builder",
  "../dockerfile": "/docs/dockerfile",
  "../vm-executor": "/docs/vm-executor",
  // The guides live in docs/ and cross-link as files, so they read on GitHub too.
  "./cli.md": "/docs/cli",
  "./library.md": "/docs/library",
  "./agents.md": "/docs/agents",
  "docs/cli.md": "/docs/cli",
  "docs/library.md": "/docs/library",
  "docs/agents.md": "/docs/agents",
  "../README.md": "/docs/overview",
  "../packages/beambox/README.md": "/docs/beambox",
  "skills/beambox/SKILL.md": "https://github.com/beamhop/beambox/blob/main/skills/beambox/SKILL.md",
  "../skills/beambox/SKILL.md":
    "https://github.com/beamhop/beambox/blob/main/skills/beambox/SKILL.md",
}

export const resolveDocLink = (href: string): string => LINK_MAP[href] ?? href
