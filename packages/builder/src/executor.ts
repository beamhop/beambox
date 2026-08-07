import type { BlobStore, BuiltLayer, ImageArtifact, LayerEntry, Platform } from "@beamhop/oci"
import type { RunMount } from "./spec.ts"

/** Execute a command against the stage's current filesystem. */
export interface RunStep {
  readonly kind: "run"
  /** Fully resolved argv — shell wrapping has already been applied. */
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly workdir: string
  readonly user?: string
  readonly mounts: readonly RunMount[]
  /** Human-readable form, used in errors and history. */
  readonly instruction: string
}

/**
 * Write files into the stage's filesystem.
 *
 * When a session is open these must go through the sandbox rather than being layered on
 * the host, so that a following `RUN` actually sees them.
 */
export interface MaterializeStep {
  readonly kind: "materialize"
  readonly entries: readonly LayerEntry[]
  readonly instruction: string
}

export type ExecutionStep = RunStep | MaterializeStep

export interface ExecutionContext {
  readonly store: BlobStore
  readonly platform: Platform
  /** The image the sandbox must boot from — everything built in this stage so far. */
  readonly base: ImageArtifact
  /**
   * Every mount declared by any `RUN` in this stage.
   *
   * Sandboxes take their mounts at creation time, so the whole stage's set has to be
   * known up front rather than discovered step by step.
   */
  readonly mounts: readonly RunMount[]
  /** Directory `RUN --mount=type=bind` reads from. */
  readonly contextDir: string
  /** Called with output as it is produced, for live build logs. */
  readonly onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void
  /** Non-fatal problems, such as a sandbox that could not be cleaned up. */
  readonly onWarning?: (message: string) => void
}

/**
 * A live sandbox for one stage.
 *
 * Steps are applied in order against the same filesystem, and each returns the layer
 * capturing exactly what it changed — or `undefined` when it changed nothing, which is
 * how a `RUN` that only reads avoids producing an empty layer.
 */
export interface ExecutorSession {
  apply(step: ExecutionStep): Promise<BuiltLayer | undefined>
  close(): Promise<void>
}

/**
 * Runs the steps a declarative build cannot.
 *
 * The builder depends only on this interface, never on microsandbox directly — which is
 * what keeps a `RUN`-free build free of any runtime dependency, and what lets the engine
 * be tested without booting a VM.
 */
export interface Executor {
  readonly name: string
  /** Report whether this executor can run steps for `platform`, and why not if it cannot. */
  supports(platform: Platform): { supported: true } | { supported: false; reason: string }
  open(context: ExecutionContext): Promise<ExecutorSession>
}
