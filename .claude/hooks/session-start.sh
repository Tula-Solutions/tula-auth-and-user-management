#!/usr/bin/env bash
# SessionStart: print a short status block that Claude receives as context.
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0

branch=$(git branch --show-current 2>/dev/null || echo '?')
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

if [ -L "$HOME/.claude/skills/otterbot-review" ] || [ -d "$HOME/.claude/skills/otterbot-review" ]; then
  ollie='installed'
else
  ollie='MISSING — install: git clone https://github.com/otternaut/otterbot ~/tools/otterbot && ~/tools/otterbot/scripts/install'
fi

if command -v docker >/dev/null 2>&1 && docker compose ps --status running -q 2>/dev/null | grep -q .; then
  services=$(docker compose ps --status running --format '{{.Service}}' 2>/dev/null | tr '\n' ' ')
else
  services='not running (docker compose up -d)'
fi

if [ -f .claude/.state/last-pass ]; then
  gate='last verify:changed passed'
else
  gate='no recorded pass yet'
fi

cat <<MSG
Tula Auth session context
- branch: $branch ($dirty changed files)
- docker services: $services
- otterbot-review: $ollie
- stop-gate: $gate
- Definition of done: bun run verify green + /review-loop (Ollie on Sonnet 5.5) with no blocking findings.
MSG
exit 0
