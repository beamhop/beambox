import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { BuildPlan } from "@beamhop/builder"
import { parseDockerfile } from "@beamhop/dockerfile"
import type { BuiltImage } from "./result.ts"
import { type BuildSettings, buildPlan } from "./spec.ts"

export interface DockerfileSettings extends BuildSettings {
  /** Build only up to this stage, as `docker build --target` does. */
  readonly target?: string
}

/** A parsed Dockerfile, ready to build. */
export interface DockerfileBuild {
  readonly plan: BuildPlan
  build(settings?: DockerfileSettings): Promise<BuiltImage>
}

const withTarget = (plan: BuildPlan, target: string | undefined): BuildPlan =>
  target === undefined ? plan : { ...plan, target }

/**
 * Build from Dockerfile text.
 *
 * The Dockerfile is parsed into the same plan the TypeScript API produces, so both go
 * through one build engine and behave identically.
 */
export const dockerfileText = (
  text: string,
  settings: DockerfileSettings = {},
): DockerfileBuild => {
  const parsed = parseDockerfile(text, {
    ...(settings.context !== undefined ? { context: settings.context } : {}),
  })

  return {
    plan: parsed,
    build: (overrides = {}) => {
      const merged = { ...settings, ...overrides }
      return buildPlan(withTarget(parsed, merged.target), merged)
    },
  }
}

/**
 * Build from a Dockerfile on disk.
 *
 * The build context defaults to the Dockerfile's own directory, which is what a bare
 * `beam build .` should mean.
 */
export const dockerfile = async (
  path: string,
  settings: DockerfileSettings = {},
): Promise<DockerfileBuild> => {
  const absolute = resolve(path)
  const contents = await readFile(absolute, "utf8").catch(() => undefined)

  if (contents === undefined) {
    throw new Error(`Dockerfile not found: ${absolute}`)
  }

  return dockerfileText(contents, {
    context: settings.context ?? dirname(absolute),
    ...settings,
  })
}
