#!/usr/bin/env bash
# Build the ChatGPT Apps directory package: chatgpt/ plus the shared skill, zipped
# to dist/openmail-chatgpt.zip. The skill is copied at build time so the one in
# skills/openmail stays the single source for every host.
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R chatgpt/. "$STAGE/"
mkdir -p "$STAGE/skills"
cp -R skills/openmail "$STAGE/skills/openmail"

python3 - "$STAGE/plugin.json" <<'EOF'
import json, sys
json.load(open(sys.argv[1]))
EOF

mkdir -p dist
rm -f dist/openmail-chatgpt.zip
(cd "$STAGE" && zip -qr -X "$OLDPWD/dist/openmail-chatgpt.zip" . -x '.DS_Store')
unzip -l dist/openmail-chatgpt.zip
