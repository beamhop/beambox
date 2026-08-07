#!/usr/bin/env bash
# Publish every package to npm, dependencies first.
#
# `bun publish` is required rather than `npm publish`: it rewrites the `workspace:*`
# dependency ranges to the version actually being published. npm would ship the literal
# string and every install would fail.
#
# Usage: scripts/publish.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."

# Dependency order: a package is published only after everything it imports.
PACKAGES=(oci registry builder dockerfile microsandbox beambox)

if ! bun pm whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
fi

echo "Building all packages…"
bun run build

# Preflight. `bun publish` rewrites `workspace:*` using the version recorded in bun.lock,
# which can lag behind a version bump in package.json — 0.1.1 shipped depending on the
# broken 0.1.0 that way. Pack each tarball first and read back what it actually declares.
echo "Verifying packed dependency ranges…"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

for name in "${PACKAGES[@]}"; do
  (cd "packages/$name" && bun pm pack --destination "$STAGING" >/dev/null)
done

VERSION="$(node -p "require('./packages/beambox/package.json').version")"
node - "$STAGING" "$VERSION" <<'NODE'
const { execSync } = require("node:child_process")
const { readdirSync } = require("node:fs")
const [staging, version] = process.argv.slice(2)
let bad = 0

for (const file of readdirSync(staging).filter((f) => f.endsWith(".tgz"))) {
  const raw = execSync(`tar -xzOf ${JSON.stringify(`${staging}/${file}`)} package/package.json`)
  const pkg = JSON.parse(raw.toString())
  if (pkg.version !== version) {
    console.error(`${pkg.name}: version ${pkg.version}, expected ${version}`)
    bad++
  }
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!dep.startsWith("@beamhop/")) continue
    if (range !== version) {
      console.error(`${pkg.name}: depends on ${dep}@${range}, expected ${version}`)
      bad++
    }
  }
}

if (bad > 0) {
  console.error("\nRefusing to publish. Delete bun.lock, run `bun install`, and retry.")
  process.exit(1)
}
console.log(`All ${version} tarballs declare consistent @beamhop ranges.`)
NODE

for name in "${PACKAGES[@]}"; do
  echo
  echo "── publishing packages/$name"
  # stdin is closed deliberately: with 2FA required for writes, publish otherwise blocks
  # on an invisible one-time-password prompt instead of failing. Use an npm automation
  # token, which is exempt from the prompt.
  (cd "packages/$name" && bun publish --access public "$@" </dev/null)
done

echo
echo "Done. Try it with: npx @beamhop/beambox version"
