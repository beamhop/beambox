import type { Platform } from "@beamhop/oci"

/** How a stage obtains its starting filesystem. */
export type BaseSource =
  /** An empty rootfs — Dockerfile's `FROM scratch`. */
  | { readonly kind: "scratch" }
  /** An image pulled from a registry. */
  | { readonly kind: "registry"; readonly reference: string }
  /** The result of an earlier stage in the same build. */
  | { readonly kind: "stage"; readonly stage: string }

/** A command to run, in either of Dockerfile's two forms. */
export type Command =
  /** `RUN apt-get update` — interpreted by the image's shell. */
  | { readonly form: "shell"; readonly command: string }
  /** `RUN ["apt-get", "update"]` — executed directly, no shell involved. */
  | { readonly form: "exec"; readonly argv: readonly string[] }

/** A mount available only for the duration of one `RUN`. */
export type RunMount =
  /** Persistent, shared across builds — package manager caches and the like. */
  | {
      readonly type: "cache"
      readonly target: string
      readonly id?: string
      readonly readonly?: boolean
    }
  /** A directory from the build context or an earlier stage. */
  | {
      readonly type: "bind"
      readonly target: string
      readonly source?: string
      readonly from?: string
    }
  /** An empty in-memory filesystem. */
  | { readonly type: "tmpfs"; readonly target: string }

export interface CopySource {
  /** Paths relative to the build context, or to `from` when set. May contain globs. */
  readonly sources: readonly string[]
  readonly destination: string
  /** Copy out of a named stage or an image instead of the build context. */
  readonly from?: string
  /** `--chown=user:group`, applied to every entry. */
  readonly chown?: string
  /** `--chmod=0755`, applied to every entry. */
  readonly chmod?: string
}

/**
 * One step of a build. Ops are applied in order; each either contributes a layer
 * (`copy`, `add`, `run`) or only changes the image config (everything else).
 */
export type BuildOp =
  | ({ readonly kind: "copy" } & CopySource)
  | ({ readonly kind: "add" } & CopySource)
  | {
      readonly kind: "run"
      readonly command: Command
      readonly mounts?: readonly RunMount[]
      /** Extra environment for this step only, as `RUN FOO=bar cmd` would give. */
      readonly env?: Readonly<Record<string, string>>
    }
  | { readonly kind: "env"; readonly values: Readonly<Record<string, string>> }
  | { readonly kind: "arg"; readonly name: string; readonly defaultValue?: string }
  | { readonly kind: "label"; readonly values: Readonly<Record<string, string>> }
  | { readonly kind: "workdir"; readonly path: string }
  | { readonly kind: "user"; readonly user: string }
  | { readonly kind: "cmd"; readonly command: Command | null }
  | { readonly kind: "entrypoint"; readonly command: Command | null }
  | { readonly kind: "expose"; readonly ports: readonly string[] }
  | { readonly kind: "volume"; readonly paths: readonly string[] }
  | { readonly kind: "stopsignal"; readonly signal: string }
  | { readonly kind: "shell"; readonly shell: readonly string[] }
  | {
      readonly kind: "healthcheck"
      readonly test: readonly string[] | null
      readonly interval?: number
      readonly timeout?: number
      readonly startPeriod?: number
      readonly retries?: number
    }

export interface Stage {
  /** `FROM … AS name`. Absent for an unnamed stage. */
  readonly name?: string
  readonly base: BaseSource
  readonly ops: readonly BuildOp[]
  /** `FROM --platform=…`, overriding the build's target platform for this stage. */
  readonly platform?: Platform
}

/**
 * A complete build. Stages are ordered as written; the last one produces the image
 * unless `target` names an earlier one.
 */
export interface BuildPlan {
  readonly stages: readonly Stage[]
  /** Build the named stage instead of the final one, as `docker build --target` does. */
  readonly target?: string
  /** Directory that `COPY` and `ADD` read from. */
  readonly context?: string
  /** Values for `ARG`s, overriding their defaults. */
  readonly buildArgs?: Readonly<Record<string, string>>
}

/** True when the op changes the filesystem and therefore produces a layer. */
export const producesLayer = (op: BuildOp): boolean =>
  op.kind === "copy" || op.kind === "add" || op.kind === "run"

/** The shell Dockerfile uses to interpret shell-form commands when none is set. */
export const DEFAULT_SHELL: readonly string[] = ["/bin/sh", "-c"]

/** Resolve a command to the argv a runtime would actually execute. */
export const commandToArgv = (command: Command, shell: readonly string[]): readonly string[] =>
  command.form === "exec" ? command.argv : [...shell, command.command]

/** How an instruction reads in `history`, matching what `docker history` would show. */
export const commandText = (command: Command): string =>
  command.form === "exec" ? JSON.stringify(command.argv) : command.command
