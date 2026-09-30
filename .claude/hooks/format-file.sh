#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): format + autofix the edited file with Biome. Never blocks.
command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty')
[ -z "$file" ] || [ ! -f "$file" ] && exit 0

case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
biome="$root/node_modules/.bin/biome"
[ -x "$biome" ] || exit 0
"$biome" check --write --no-errors-on-unmatched "$file" >/dev/null 2>&1 || true
exit 0
