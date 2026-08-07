# @beambox/site

The beambox documentation site — <https://beamhop.github.io/beambox/>.

A Vite + React single-page app. The landing page is hand-written; every documentation page
is the corresponding `README.md`, imported straight from the repository and rendered at
runtime, so the site cannot drift from the packages it documents.

```bash
bun run site:dev     # from the repository root — http://localhost:5173/beambox/
bun run site:build   # writes site/dist
```

Or from this directory:

```bash
bun run dev
bun run build
bun run preview
bun run typecheck
```

## How it fits together

| Path | What lives there |
| --- | --- |
| `src/styles.css` | Every design token — colour, type scale, rhythm, shape, depth, motion. Restyling the site means editing this file and nothing else. |
| `src/content/site.ts` | Landing-page copy: features, packages, limits, the instruction support matrix. |
| `src/content/docs.ts` | The docs registry — one entry per README, plus the repo-relative link rewrites. |
| `src/components/reactbits/` | [React Bits](https://reactbits.dev) components, vendored verbatim. |
| `src/components/home/` | The landing-page sections. |
| `src/lib/highlighter.ts` | Shiki, loaded fine-grained: one engine and four grammars, only when a code block mounts. |

## Adding a documentation page

1. Add the README to `DOC_PAGES` in `src/content/docs.ts`.
2. If it links to other packages by relative path, add those paths to `LINK_MAP` in the
   same file.

The sidebar, the footer, the previous/next links, and the deploy trigger all read from
that one array.

## Vendored components

React Bits is a copy-in library, not a dependency. Components were taken from the
`ts-tailwind` variant of [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits)
and are left byte-for-byte unmodified apart from a header comment, so they can be
re-synced. They carry `@ts-nocheck` because they do not satisfy this repository's
`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` settings; everything outside
that directory does.

In use: `Beams` (hero background), `SplitText`, `ShinyText`, `TextType`, `SpotlightCard`,
`StarBorder`, `CountUp`, `ClickSpark`.

Scroll reveals are **not** vendored. `Reveal` in `src/components/Section.tsx` uses an
IntersectionObserver and a CSS transition rather than a GSAP timeline: a rAF-driven tween
freezes when the tab is backgrounded and can strand body copy at half opacity, whereas a
class flip always lands on its end state and collapses to nothing under
`prefers-reduced-motion`.

## Deployment

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on every push to `main`
that touches the site or any README. The Vite `base` and the router `basename` are both
`/beambox/`; `bun run build` copies `index.html` to `404.html` so deep links like
`/beambox/docs/oci` survive a hard refresh on Pages' static host.
