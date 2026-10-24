#!/bin/bash
# Release binaries: dist/fornax-<os>-<arch>
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
# the dashboard's stylesheet (Tailwind), embedded into the binaries below
bun run --silent ui:css
# baked into every binary: servers are only ever updated to a newer build, never downgraded
build=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for t in linux-arm64 linux-x64 darwin-arm64 darwin-x64; do
  bun build --compile --minify --target="bun-$t" --define "FORNAX_BUILD=\"$build\"" src/cli.ts --outfile "dist/fornax-$t" >/dev/null
  echo "$build" > "dist/fornax-$t.build"
  echo "dist/fornax-$t $(du -h "dist/fornax-$t" | cut -f1)"
done

# Release archives: the host binary plus both Linux builds (servers need them).
v=$(bun -e 'console.log(require("./package.json").version)')
for host in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  d=$(mktemp -d)
  cp "dist/fornax-$host" "$d/fornax"; cp dist/fornax-linux-arm64 dist/fornax-linux-x64 dist/fornax-linux-arm64.build dist/fornax-linux-x64.build "$d/"
  tar -czf "dist/fornax-$v-$host.tar.gz" -C "$d" .
  rm -rf "$d"
  echo "dist/fornax-$v-$host.tar.gz $(shasum -a 256 "dist/fornax-$v-$host.tar.gz" | cut -d' ' -f1)"
done
