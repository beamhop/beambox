import beamboxReadme from "../../../packages/beambox/README.md?raw"
import builderReadme from "../../../packages/builder/README.md?raw"
import dockerfileReadme from "../../../packages/dockerfile/README.md?raw"
import microsandboxReadme from "../../../packages/microsandbox/README.md?raw"
import ociReadme from "../../../packages/oci/README.md?raw"
import registryReadme from "../../../packages/registry/README.md?raw"
import rootReadme from "../../../README.md?raw"

export interface DocPage {
  /** URL segment under /docs. */
  readonly slug: string
  /** Sidebar label. */
  readonly title: string
  /** npm name, shown in the sidebar and as the page kicker. */
  readonly pkg: string
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
    blurb: "Why beambox exists, how RUN works without Docker, and what it will not do.",
    source: "README.md",
    markdown: rootReadme,
  },
  {
    slug: "beambox",
    title: "beambox",
    pkg: "@beamhop/beambox",
    blurb: "The package you install: fluent API, Dockerfile front-end, and the beambox CLI.",
    source: "packages/beambox/README.md",
    markdown: beamboxReadme,
  },
  {
    slug: "oci",
    title: "OCI primitives",
    pkg: "@beamhop/oci",
    blurb: "Digests, deterministic layer tars, manifests, and the three archive formats.",
    source: "packages/oci/README.md",
    markdown: ociReadme,
  },
  {
    slug: "registry",
    title: "Registry client",
    pkg: "@beamhop/registry",
    blurb: "OCI Distribution v2 pull and push, in TypeScript, with no daemon.",
    source: "packages/registry/README.md",
    markdown: registryReadme,
  },
  {
    slug: "builder",
    title: "Build engine",
    pkg: "@beamhop/builder",
    blurb: "Stages, layer assembly, caching, and the pluggable RUN executor interface.",
    source: "packages/builder/README.md",
    markdown: builderReadme,
  },
  {
    slug: "dockerfile",
    title: "Dockerfile",
    pkg: "@beamhop/dockerfile",
    blurb: "Lexer, parser, typed AST, and the lowering onto the build engine.",
    source: "packages/dockerfile/README.md",
    markdown: dockerfileReadme,
  },
  {
    slug: "microsandbox",
    title: "microsandbox",
    pkg: "@beamhop/microsandbox",
    blurb: "The microVM RUN executor, the layer diff, and the msb handoff.",
    source: "packages/microsandbox/README.md",
    markdown: microsandboxReadme,
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
  "packages/microsandbox": "/docs/microsandbox",
  "../beambox": "/docs/beambox",
  "../oci": "/docs/oci",
  "../registry": "/docs/registry",
  "../builder": "/docs/builder",
  "../dockerfile": "/docs/dockerfile",
  "../microsandbox": "/docs/microsandbox",
}

export const resolveDocLink = (href: string): string => LINK_MAP[href] ?? href
