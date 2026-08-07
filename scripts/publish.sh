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
