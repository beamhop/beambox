import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

/**
 * Runs the built packages under **Node**, which the rest of the suite never does.
 *
 * This exists because `Bun.CryptoHasher` survived in the layer cache and shipped in
 * 0.1.0: every test passed under Bun, and the failure only appeared for a Node user
 * mid-build. A published package that claims Node support has to be executed by Node
 * somewhere in CI.
 *
 * `FROM scratch` is deliberate — it exercises layer assembly, the blob store, the cache
 * key, and archive writing with no registry and no network.
 */
const exec = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cli = join(root, "packages", "beambox", "dist", "cli.mjs")

const node = (args: readonly string[], cwd: string) =>
  exec(process.execPath, [...args], { cwd, maxBuffer: 1024 * 1024 * 16 })

const PACKAGES = ["oci", "registry", "builder", "dockerfile", "microsandbox", "beambox"] as const

describe("the built output runs on Node", () => {
  /*
   * The catch-all. Executing a build can only cover the paths a build happens to take —
   * the 0.1.0 regression sat in the layer cache, which no offline path reaches because
   * the executor check runs first. A static scan needs no execution and misses nothing.
   */
  test("no published bundle references the Bun global", async () => {
    const offenders: string[] = []

    for (const name of PACKAGES) {
      const dist = join(root, "packages", name, "dist")
      for (const file of await readdir(dist)) {
        if (!file.endsWith(".mjs")) continue
        const source = await readFile(join(dist, file), "utf8")
        // `Bun.` as a member access on the global; `bun` in strings or comments is fine.
        for (const match of source.matchAll(/(?<![\w.$"'`])Bun\.[A-Za-z]+/g)) {
          offenders.push(`packages/${name}/dist/${file}: ${match[0]}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  test("the CLI reports its version", async () => {
    const { stdout } = await node([cli, "version"], root)
    expect(stdout.trim()).toMatch(/^beambox \d+\.\d+\.\d+$/)
  })

  test("a scratch build produces an archive, with no network and no VM", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "beambox-node-"))
    try {
      await writeFile(join(workspace, "payload.txt"), "built by node\n")
      await writeFile(
        join(workspace, "Dockerfile"),
        'FROM scratch\nCOPY payload.txt /payload.txt\nCMD ["/payload.txt"]\n',
      )

      const { stdout, stderr } = await node(
        [cli, "build", "-t", "node-compat:local", "-o", "out.tar", "."],
        workspace,
      )
      // Progress goes to stderr; stdout is just the digest, so the CLI stays pipeable.
      expect(stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(stderr).toContain("wrote out.tar")

      // The layer cache computes a key on every step; that is where 0.1.0 threw.
      const listing = await exec("tar", ["-tf", join(workspace, "out.tar")])
      expect(listing.stdout).toContain("manifest.json")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("the library API imports and builds under Node", async () => {
    const { stdout } = await node(
      [
        "--input-type=module",
        "-e",
        `import { image } from ${JSON.stringify(join(root, "packages", "beambox", "dist", "index.mjs"))}
         const built = await image("scratch").cmd(["/x"]).build({ tags: ["api:local"] })
         console.log("layers:" + built.layers.length)`,
      ],
      root,
    )
    expect(stdout.trim()).toBe("layers:0")
  })
})
