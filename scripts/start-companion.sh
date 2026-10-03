#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 LTS or newer, then reopen this launcher.' >&2
  exit 1
fi
if [ ! -f node_modules/yauzl/package.json ]; then
  printf '%s\n' 'Run npm ci --ignore-scripts in this repository first.' >&2
  exit 1
fi
exec node tools/companion/cli.mjs --open
