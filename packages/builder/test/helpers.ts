import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BlobStore,
  type BuiltLayer,
  buildLayer,
  type ImageArtifact,
  type Platform,
} from "@beambox/oci"
import type { ExecutionContext, ExecutionStep, Executor, ExecutorSession } from "../src/executor.ts"

export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

export const withWorkspace = async (): Promise<{
  store: BlobStore
  dir: string
  context: string
  cleanup: () => Promise<void>
}> => {
  const dir = await mkdtemp(join(tmpdir(), "beambox-builder-"))
  const context = join(dir, "context")
  await Bun.write(join(context, ".keep"), "")
  return {
    store: new BlobStore(join(dir, "blobs")),
    dir,
    context,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export interface RecordedStep {
  readonly kind: ExecutionStep["kind"]
  readonly instruction: string
  readonly argv?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly workdir?: string
}

/**
 * A real `Executor` that records what it was asked to do and produces genuine layers,
 * without booting a VM.
 *
 * This is not a stand-in for microsandbox — it is a second, legitimate implementation of
 * the executor interface whose job is to make the *engine's* orchestration observable:
 * how many sandbox sessions get opened, when they close, and which steps route through
 * them. The microsandbox executor is exercised for real in the e2e suite.
 */
export class RecordingExecutor implements Executor {
  readonly name = "recording"
  readonly steps: RecordedStep[] = []
  readonly sessions: { base: string; closed: boolean }[] = []

  constructor(private readonly options: { unsupported?: string } = {}) {}

  supports(_platform: Platform): { supported: true } | { supported: false; reason: string } {
    return this.options.unsupported !== undefined
      ? { supported: false, reason: this.options.unsupported }
      : { supported: true }
  }

  get openSessions(): number {
    return this.sessions.filter((session) => !session.closed).length
  }

  async open(context: ExecutionContext): Promise<ExecutorSession> {
    const record = { base: context.base.manifestDescriptor.digest, closed: false }
    this.sessions.push(record)
    const steps = this.steps

    return {
      async apply(step: ExecutionStep): Promise<BuiltLayer | undefined> {
        if (step.kind === "run") {
          steps.push({
            kind: "run",
            instruction: step.instruction,
            argv: step.argv,
            env: step.env,
            workdir: step.workdir,
          })
          // Stand in for the filesystem change a real command would make.
          return await buildLayer(context.store, [
            {
              kind: "file",
              path: `/.recorded/${steps.length}`,
              content: bytes(step.argv.join(" ")),
            },
          ])
        }

        steps.push({ kind: "materialize", instruction: step.instruction })
        return await buildLayer(context.store, step.entries)
      },
      async close(): Promise<void> {
        record.closed = true
      },
    }
  }
}

/** Read a built image's config block, which is what most assertions care about. */
export const configOf = (image: ImageArtifact) => image.config.config ?? {}
