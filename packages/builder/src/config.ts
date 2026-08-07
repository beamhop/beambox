import { posix } from "node:path"
import type { ImageConfig, ImageConfigBlock } from "@beambox/oci"
import type { BuildOp, Command } from "./spec.ts"
import { commandToArgv, DEFAULT_SHELL } from "./spec.ts"

/** `["A=1", "B=2"]` as a lookup. A later duplicate wins, matching Docker. */
export const envToMap = (env: readonly string[] | undefined): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const entry of env ?? []) {
    const separator = entry.indexOf("=")
    if (separator > 0) map[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return map
}

export const mapToEnv = (map: Readonly<Record<string, string>>): string[] =>
  Object.entries(map).map(([key, value]) => `${key}=${value}`)

/**
 * Expand `$VAR`, `${VAR}`, `${VAR:-default}`, and `${VAR:+alternate}`.
 *
 * `\$` escapes a literal dollar sign. An unset variable expands to the empty string,
 * which is what Dockerfile does — it does not error.
 */
export const expandVariables = (text: string, vars: Readonly<Record<string, string>>): string => {
  let result = ""
  let index = 0

  while (index < text.length) {
    const character = text[index]

    if (character === "\\" && text[index + 1] === "$") {
      result += "$"
      index += 2
      continue
    }
    if (character !== "$") {
      result += character
      index += 1
      continue
    }

    if (text[index + 1] === "{") {
      const close = text.indexOf("}", index + 2)
      if (close === -1) {
        result += text.slice(index)
        break
      }
      const body = text.slice(index + 2, close)
      index = close + 1

      const defaulted = body.indexOf(":-")
      const alternate = body.indexOf(":+")
      if (defaulted > 0) {
        const name = body.slice(0, defaulted)
        result +=
          vars[name] !== undefined && vars[name] !== "" ? vars[name] : body.slice(defaulted + 2)
      } else if (alternate > 0) {
        const name = body.slice(0, alternate)
        result += vars[name] !== undefined && vars[name] !== "" ? body.slice(alternate + 2) : ""
      } else {
        result += vars[body] ?? ""
      }
      continue
    }

    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1))
    if (match === null) {
      result += character
      index += 1
      continue
    }
    result += vars[match[0]] ?? ""
    index += 1 + match[0].length
  }

  return result
}

/** The mutable state a stage accumulates as its ops are applied. */
export interface StageState {
  config: ImageConfig
  /** Shell used to wrap shell-form commands, changed by `SHELL`. */
  shell: readonly string[]
  /** `ARG` values in scope. Build-time only — never written into the image config. */
  args: Record<string, string>
}

const withConfigBlock = (
  config: ImageConfig,
  change: (block: ImageConfigBlock) => ImageConfigBlock,
): ImageConfig => ({ ...config, config: change(config.config ?? {}) })

/**
 * Resolve `WORKDIR`. Relative paths stack on the current working directory, so
 * `WORKDIR /a` followed by `WORKDIR b` lands at `/a/b`.
 */
const resolveWorkdir = (current: string | undefined, next: string): string =>
  next.startsWith("/") ? posix.normalize(next) : posix.normalize(posix.join(current ?? "/", next))

/** Variables available for expansion: `ENV` wins over `ARG`, as Dockerfile specifies. */
export const expansionScope = (state: StageState): Record<string, string> => ({
  ...state.args,
  ...envToMap(state.config.config?.Env),
})

/**
 * Apply an op that only affects the image config.
 *
 * Returns the new state; ops that produce layers are handled by the build engine and
 * fall through here unchanged.
 */
export const applyConfigOp = (state: StageState, op: BuildOp): StageState => {
  switch (op.kind) {
    case "env": {
      const merged = { ...envToMap(state.config.config?.Env), ...op.values }
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({ ...block, Env: mapToEnv(merged) })),
      }
    }

    case "arg":
      return {
        ...state,
        args: {
          ...state.args,
          // An explicit --build-arg already in scope beats the Dockerfile default.
          [op.name]: state.args[op.name] ?? op.defaultValue ?? "",
        },
      }

    case "label":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          Labels: { ...(block.Labels ?? {}), ...op.values },
        })),
      }

    case "workdir":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          WorkingDir: resolveWorkdir(block.WorkingDir, op.path),
        })),
      }

    case "user":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({ ...block, User: op.user })),
      }

    case "cmd":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          Cmd: op.command === null ? null : [...commandToArgv(op.command, state.shell)],
        })),
      }

    case "entrypoint":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          Entrypoint: op.command === null ? null : [...commandToArgv(op.command, state.shell)],
          // Docker resets CMD when ENTRYPOINT changes, so a stale CMD is not appended
          // as arguments to a completely different entrypoint.
          Cmd: null,
        })),
      }

    case "expose":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          ExposedPorts: {
            ...(block.ExposedPorts ?? {}),
            ...Object.fromEntries(
              op.ports.map((port) => [port.includes("/") ? port : `${port}/tcp`, {}]),
            ),
          },
        })),
      }

    case "volume":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          Volumes: {
            ...(block.Volumes ?? {}),
            ...Object.fromEntries(op.paths.map((path) => [path, {}])),
          },
        })),
      }

    case "stopsignal":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({ ...block, StopSignal: op.signal })),
      }

    case "shell":
      return { ...state, shell: op.shell }

    case "healthcheck":
      return {
        ...state,
        config: withConfigBlock(state.config, (block) => ({
          ...block,
          Healthcheck: {
            ...(op.test !== null ? { Test: [...op.test] } : { Test: ["NONE"] }),
            ...(op.interval !== undefined ? { Interval: op.interval } : {}),
            ...(op.timeout !== undefined ? { Timeout: op.timeout } : {}),
            ...(op.startPeriod !== undefined ? { StartPeriod: op.startPeriod } : {}),
            ...(op.retries !== undefined ? { Retries: op.retries } : {}),
          },
        })),
      }

    // Layer-producing ops are applied by the build engine.
    case "copy":
    case "add":
    case "run":
      return state
  }
}

/** Expand variables inside an op, using the values currently in scope. */
export const expandOp = (op: BuildOp, vars: Readonly<Record<string, string>>): BuildOp => {
  const expand = (value: string): string => expandVariables(value, vars)
  const expandCommand = (command: Command): Command =>
    command.form === "shell"
      ? { form: "shell", command: expand(command.command) }
      : { form: "exec", argv: command.argv.map(expand) }

  switch (op.kind) {
    case "copy":
    case "add":
      return {
        ...op,
        sources: op.sources.map(expand),
        destination: expand(op.destination),
        ...(op.from !== undefined ? { from: expand(op.from) } : {}),
      }
    case "run":
      return { ...op, command: expandCommand(op.command) }
    case "env":
      return {
        ...op,
        values: Object.fromEntries(Object.entries(op.values).map(([k, v]) => [k, expand(v)])),
      }
    case "label":
      return {
        ...op,
        values: Object.fromEntries(Object.entries(op.values).map(([k, v]) => [k, expand(v)])),
      }
    case "workdir":
      return { ...op, path: expand(op.path) }
    case "user":
      return { ...op, user: expand(op.user) }
    case "cmd":
    case "entrypoint":
      return { ...op, command: op.command === null ? null : expandCommand(op.command) }
    case "expose":
      return { ...op, ports: op.ports.map(expand) }
    case "volume":
      return { ...op, paths: op.paths.map(expand) }
    case "stopsignal":
      return { ...op, signal: expand(op.signal) }
    case "arg":
    case "shell":
    case "healthcheck":
      return op
  }
}

export const initialState = (config: ImageConfig, args: Record<string, string>): StageState => ({
  config,
  shell: DEFAULT_SHELL,
  args,
})
