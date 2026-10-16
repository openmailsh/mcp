#!/usr/bin/env bash
# Builds the ZIP uploaded to the OpenAI plugin submission portal.
# Only plugin files go in; server code, `.mcp.json` (Claude format) and
# other manifests stay out.
set -euo pipefail

cd "$(dirname "$0")/.."
out="openmail-openai-plugin.zip"
rm -f "$out"
zip -rq "$out" .codex-plugin mcp.json skills assets -x '*.DS_Store'
echo "Wrote $out"
unzip -l "$out"
