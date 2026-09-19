#!/usr/bin/env bash
# Build a self-contained Yenop bundle that installs with no network, for air-gapped and on-prem machines.
#
# Run this on a build machine that HAS internet. It produces yenop-offline-<version>.tgz containing the
# built code, the baseline policies, and the one production dependency (the Cedar policy engine, a wasm
# module) already resolved. The target machine needs only Node; no npm registry, no internet.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
version="$(node -e 'process.stdout.write(require("./package.json").version)')"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "yenop offline bundle ${version}"
echo "  building…"
npm run build >/dev/null

echo "  staging files…"
mkdir -p "$stage/yenop"
cp -R dist policies package.json README.md LICENSE.md "$stage/yenop/"

echo "  resolving the production dependency (needs network, on this build machine only)…"
( cd "$stage/yenop" && npm install --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 )
rm -f "$stage/yenop/package-lock.json"

cat > "$stage/yenop/INSTALL.txt" <<'TXT'
Yenop — offline install
========================

This bundle contains everything Yenop needs. The target machine requires only
Node.js 20 or newer. No internet, no npm registry.

Option A — no npm needed (recommended for locked-down machines)
  1. Move this folder somewhere permanent, e.g.:
       sudo mv yenop /opt/yenop
  2. Put it on PATH with a symlink:
       sudo ln -s /opt/yenop/dist/cli/main.js /usr/local/bin/yenop
       sudo chmod +x /opt/yenop/dist/cli/main.js
  3. Check it:
       yenop --help
       yenop demo

Option B — with npm, no network
     npm install -g --offline ./yenop
  (all dependencies are already inside ./yenop/node_modules, so npm fetches
   nothing.)

Keep the daemon alive under the OS supervisor (optional, enables the fast hook):
     yenop service install       # launchd on macOS, systemd --user on Linux
On a headless Linux server, also allow the user service to run after logout:
     loginctl enable-linger "$USER"

Set up a project:
     cd your-project && yenop init

Everything Yenop records stays on this machine, in ~/.yenop.
TXT

out="$here/yenop-offline-${version}.tgz"
echo "  packing…"
tar -czf "$out" -C "$stage" yenop
echo "done: $out"
node -e "const s=require('fs').statSync('$out').size; console.log('  size:', Math.round(s/1024/1024*10)/10, 'MB')"
