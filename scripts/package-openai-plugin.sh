#!/usr/bin/env bash
# Builds the ZIP uploaded to the OpenAI plugin submission portal.
# Only plugin files go in. The root `mcp.json` (Cursor) and `.mcp.json`
# (Claude) stay out: OpenAI needs `streamable-http` and an auth block, so the
# ZIP gets `openai/mcp.json` as its root `mcp.json` instead.
set -euo pipefail

cd "$(dirname "$0")/.."
out="$PWD/openmail-openai-plugin.zip"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp -R .codex-plugin skills assets "$stage/"
cp openai/mcp.json "$stage/mcp.json"

rm -f "$out"
(cd "$stage" && zip -rq "$out" .codex-plugin mcp.json skills assets -x '*.DS_Store')
echo "Wrote $out"
unzip -l "$out"
