import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createOnigurumaEngine } from "shiki/engine/oniguruma"

export const LANGUAGES = ["ts", "bash", "docker", "json", "text"] as const
export type Language = (typeof LANGUAGES)[number]

const ALIASES: Readonly<Record<string, Language>> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  javascript: "ts",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  console: "bash",
  docker: "docker",
  dockerfile: "docker",
  json: "json",
}

export const toLanguage = (value: string | undefined): Language =>
  (value !== undefined && ALIASES[value.toLowerCase()]) || "text"

/*
 * Shiki is loaded fine-grained (one engine, four grammars) and only when a code block
 * actually mounts, so the WASM and grammar payload stays out of the initial route.
 */
let pending: Promise<HighlighterCore> | undefined

export const getHighlighter = (): Promise<HighlighterCore> => {
  pending ??= createHighlighterCore({
    themes: [import("shiki/themes/poimandres.mjs")],
    langs: [
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/docker.mjs"),
      import("shiki/langs/json.mjs"),
    ],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  })
  return pending
}

export const highlight = async (code: string, lang: Language): Promise<string> => {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, {
    lang: lang === "text" ? "text" : lang,
    theme: "poimandres",
    // The site supplies the surface; the theme only supplies the ink.
    colorReplacements: { "#1b1e28": "transparent" },
  })
}
