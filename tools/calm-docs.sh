#!/usr/bin/env bash
# Validates the FINOS CALM model of Interlock and regenerates architecture/README.md from it.
# Usage: tools/calm-docs.sh validate | generate | check
# The CALM CLI is fetched on demand at a pinned version, so `npm install` stays light.
set -euo pipefail
cd "$(dirname "$0")/.."
CALM="npx -y @finos/calm-cli@1.74.0"
ARCH=architecture/interlock.architecture.json
MAP=architecture/url-mapping.json
generate() {
  local out; out="$(mktemp -d)"
  $CALM docify -a "$ARCH" -u "$MAP" -t architecture/README.md.hbs -o "$out/README.md" > "$out/log" 2>&1 || { cat "$out/log" >&2; exit 1; }
  # docify writes front matter with machine-specific paths; the committed page must not depend on the machine.
  awk 'NR==1 && $0=="---"{fm=1; next} fm && $0=="---"{fm=0; next} !fm' "$out/README.md" > "$1"
  rm -rf "$out"
}
case "${1:-validate}" in
  validate) $CALM validate -a "$ARCH" -u "$MAP" --strict -f pretty ;;
  generate) generate architecture/README.md && echo "wrote architecture/README.md" ;;
  check)
    tmp="$(mktemp)"; generate "$tmp"
    if ! diff -u architecture/README.md "$tmp"; then
      echo "architecture/README.md is out of date: run npm run calm:docs and commit it" >&2; rm -f "$tmp"; exit 1
    fi
    rm -f "$tmp"; echo "architecture/README.md is up to date" ;;
  *) echo "usage: $0 validate|generate|check" >&2; exit 2 ;;
esac
