#!/bin/bash

# DEMO recording script
# Run this to generate a new gif that is linked on the README
# Update lsbench.tape accordingly to match any API changes
#
# Builds lsbench from this checkout and puts that build first on PATH,
# so the recording always uses the latest local lsbench.

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/.." && pwd)"
MINILOGO_DIR="$REPO_DIR/.integration/langium-minilogo"

if [ ! -d "$MINILOGO_DIR/out" ]; then
    echo "error: no built minilogo server at $MINILOGO_DIR/out" >&2
    echo "run 'npm run test:integration' once to fetch and build it" >&2
    exit 1
fi

# build the latest lsbench
(cd "$REPO_DIR" && npm run build)

# expose the fresh build as `lsbench` via a temporary bin dir on PATH
BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$BIN_DIR"' EXIT
ln -s "$REPO_DIR/dist/cli.js" "$BIN_DIR/lsbench"
chmod +x "$REPO_DIR/dist/cli.js"
export PATH="$BIN_DIR:$PATH"
echo "using lsbench $(lsbench --version) from $REPO_DIR/dist/cli.js"

# let script.ts import from 'lsbench', resolving to this same build so
# addRegisteredLanguage() updates the registry the CLI reads
mkdir -p "$MINILOGO_DIR/node_modules"
ln -sfn "$REPO_DIR" "$MINILOGO_DIR/node_modules/lsbench"

# copy over assets
cp "$DEMO_DIR/gallery.logo" "$MINILOGO_DIR/examples/gallery.logo"
cp "$DEMO_DIR/script.ts" "$MINILOGO_DIR/script.ts"

# roll the tape
cd "$DEMO_DIR"
vhs lsbench.tape
