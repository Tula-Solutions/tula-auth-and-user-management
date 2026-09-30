#!/usr/bin/env bash
# Stop: before Claude finishes, run the affected-package quality gate.
# Fails → exit 2 with the errors so Claude keeps fixing (up to MAX_ATTEMPTS, then it may stop
# and must report). Passes → remember the tree fingerprint so an unchanged tree isn't re-checked.
set -uo pipefail

MAX_ATTEMPTS=5
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
state="$root/.claude/.state"
mkdir -p "$state"
cd "$root" || exit 0

# Nothing to check without dependencies installed or in a non-git dir.
[ -d node_modules ] || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Fingerprint = HEAD + tracked diff + untracked file list/contents (excluding runtime state).
fingerprint=$( {
  git rev-parse HEAD 2>/dev/null || echo 'no-head'
  git diff HEAD 2>/dev/null || { git diff --cached; git diff; }
  git ls-files --others --exclude-standard | grep -v '^\.claude/\.state/' | while read -r f; do
    echo "$f"
    shasum "$f" 2>/dev/null
  done
} | shasum | cut -d' ' -f1)

if [ "$(cat "$state/last-pass" 2>/dev/null)" = "$fingerprint" ]; then
  exit 0
fi

output=$(bun run verify:changed 2>&1)
status=$?

if [ $status -eq 0 ]; then
  echo "$fingerprint" >"$state/last-pass"
  rm -f "$state/stop-attempts"
  exit 0
fi

attempts=$(($(cat "$state/stop-attempts" 2>/dev/null || echo 0) + 1))
echo "$attempts" >"$state/stop-attempts"

if [ "$attempts" -gt "$MAX_ATTEMPTS" ]; then
  rm -f "$state/stop-attempts"
  printf '{"systemMessage":"stop-gate: verify:changed still failing after %s attempts — Claude was allowed to stop; failures must be reported."}\n' "$MAX_ATTEMPTS"
  exit 0
fi

{
  echo "stop-gate: \`bun run verify:changed\` failed (attempt $attempts/$MAX_ATTEMPTS). Fix these before finishing:"
  echo
  # Keep the tail: turbo/biome print the actionable errors last.
  echo "$output" | grep -vE '^\s*$' | tail -n 80
} >&2
exit 2
