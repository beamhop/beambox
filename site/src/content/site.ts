// Read from the package being documented, so the badge cannot drift from what ships.
import { version } from "../../../packages/beambox/package.json"

export const VERSION = version

export const GITHUB_URL = "https://github.com/beamhop/beambox"
export const NPM_URL = "https://www.npmjs.com/package/@beamhop/beambox"
export const MICROSANDBOX_URL = "https://microsandbox.dev"
export const REACT_BITS_URL = "https://reactbits.dev"

export const editUrl = (source: string): string => `${GITHUB_URL}/blob/main/${source}`

/** The hero's one-liner: the CLI needs a global install to put `beambox` on PATH. */
export const INSTALL_COMMAND = "bun add -g @beamhop/beambox"

export interface InstallRoute {
  readonly title: string
  readonly note: string
  /** Each line is one command; the first is the recommended form. */
  readonly commands: readonly string[]
}

export const INSTALL_ROUTES: readonly InstallRoute[] = [
  {
    title: "Install the CLI",
    note: "The -g is what puts the beambox binary on your PATH. Without it the package is only a project dependency, and the command will not exist in your shell.",
    commands: ["bun add -g @beamhop/beambox", "npm i -g @beamhop/beambox"],
  },
  {
    title: "Run it without installing",
    note: "Fetches, runs, and forgets — handy in CI, or to try a build before committing to anything.",
    commands: [
      "bunx @beamhop/beambox build -t my-app:local .",
      "npx @beamhop/beambox build -t my-app:local .",
    ],
  },
  {
    title: "Use it as a library",
    note: "A normal project dependency, for the fluent API and the Dockerfile front-end. No global install involved.",
    commands: ["bun add @beamhop/beambox", "npm i @beamhop/beambox"],
  },
  {
    title: "Teach your coding agent",
    note: "Installs the beambox agent skill into .claude/skills (or your agent's equivalent), so Claude Code, Cursor, and Copilot build microsandbox images instead of reaching for Docker. Add -g for every project.",
    commands: ["npx skills add beamhop/beambox", "npx skills add beamhop/beambox -g"],
  },
]

export interface PackageCard {
  readonly name: string
  readonly slug: string
  readonly summary: string
}

export const PACKAGES: readonly PackageCard[] = [
  {
    name: "@beamhop/beambox",
    slug: "beambox",
    summary: "The package you install: fluent API, Dockerfile front-end, and the beambox CLI.",
  },
  {
    name: "@beamhop/oci",
    slug: "oci",
    summary: "OCI primitives — digests, deterministic layer tars, manifests, archive formats.",
  },
  {
    name: "@beamhop/registry",
    slug: "registry",
    summary: "OCI Distribution v2 client — pull and push, no daemon.",
  },
  {
    name: "@beamhop/builder",
    slug: "builder",
    summary: "The build engine: stages, layer assembly, caching, executor interface.",
  },
  {
    name: "@beamhop/dockerfile",
    slug: "dockerfile",
    summary: "Dockerfile lexer and parser, lowered onto the build engine.",
  },
  {
    name: "@beamhop/vm-executor",
    slug: "vm-executor",
    summary: "The microVM RUN executor and the msb handoff.",
  },
]

/** Straight from the root README's support matrix — kept in the same order. */
export const SUPPORTED_INSTRUCTIONS = [
  "FROM",
  "RUN",
  "COPY",
  "ADD",
  "ENV",
  "ARG",
  "LABEL",
  "WORKDIR",
  "USER",
  "CMD",
  "ENTRYPOINT",
  "EXPOSE",
  "VOLUME",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
] as const

export const SUPPORTED_EXTRAS = [
  "multi-stage",
  "heredocs",
  "line continuations",
  "escape directive",
  "variable expansion",
  ".dockerignore",
  "--mount=cache|bind|tmpfs",
  "--from",
  "--chown",
  "--chmod",
  "tar auto-extraction",
  "--platform",
] as const

export const REFUSED_INSTRUCTIONS = [
  "ONBUILD",
  "MAINTAINER",
  "ADD from a URL",
  "RUN --mount=type=secret",
  "RUN --mount=type=ssh",
  "RUN --network",
  "RUN --security",
  "non-default BuildKit frontends",
] as const

export interface Limit {
  readonly title: string
  readonly body: string
}

export const LIMITS: readonly Limit[] = [
  {
    title: "RUN only builds for the host architecture",
    body: "microsandbox boots native microVMs with no emulation layer, so --platform linux/amd64 with a RUN step cannot work on an arm64 host. beambox fails with PlatformMismatchError rather than mislabelling the image. Declarative builds can target any platform, because nothing is executed.",
  },
  {
    title: "RUN needs the microsandbox runtime",
    body: "Declarative builds do not. A spec with no RUN step never boots a VM and never loads the SDK.",
  },
  {
    title: "Layer diffs use size, mtime, and mode",
    body: "Content rewritten in place with all three preserved would not be detected.",
  },
  {
    title: "--chown takes numeric IDs",
    body: "Names would require reading the image's /etc/passwd.",
  },
]

export interface Feature {
  readonly title: string
  readonly body: string
  readonly glyph: string
}

export const FEATURES: readonly Feature[] = [
  {
    glyph: "◇",
    title: "No daemon, no root",
    body: "Nothing to install and nothing privileged. beambox pulls, assembles, and pushes images from a plain user process.",
  },
  {
    glyph: "⧉",
    title: "Deterministic layers",
    body: "Layer tars are built entry by entry with normalised metadata, streamed into a content-addressed store. The same input gives the same digest.",
  },
  {
    glyph: "⊘",
    title: "Refusals, not silence",
    body: "Unsupported instructions fail by name and line number. An instruction that quietly does nothing produces an image that looks right and behaves wrong.",
  },
  {
    glyph: "⌁",
    title: "Typed errors",
    body: "RunFailedError carries the exit code and output. DockerfileParseError carries line and column. Every failure is a class you can catch.",
  },
  {
    glyph: "≋",
    title: "Cache mounts that persist",
    body: "A cache mount becomes a microsandbox named volume, so the npm cache survives between builds — and never lands in the image.",
  },
  {
    glyph: "⇄",
    title: "Registry client included",
    body: "Pull and push against any OCI Distribution v2 registry. Credentials in ~/.docker/config.json are picked up automatically.",
  },
]
