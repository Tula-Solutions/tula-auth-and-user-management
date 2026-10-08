#!/usr/bin/env bash
# One-click self-hosted stack for super.engineering's Run button:
# Postgres + Redis + Mailpit (Docker), migrations, the API, and the dashboard.
#   API        http://localhost:3003  (reference at /v1/docs)
#   Dashboard  http://localhost:5175/dashboard/
#   Mailpit    http://localhost:8025
set -euo pipefail
cd "$(dirname "$0")/.."

# A fresh worktree has no .env (it is gitignored): borrow the one from the main checkout.
if [ ! -f .env ]; then
  if [ -n "${SUPER_ENGINEERING_ROOT_PATH:-}" ] && [ -f "$SUPER_ENGINEERING_ROOT_PATH/.env" ]; then
    cp "$SUPER_ENGINEERING_ROOT_PATH/.env" .env
  else
    cp .env.example .env
    sed -i.bak "s|^TULA_MASTER_KEY=.*|TULA_MASTER_KEY=$(openssl rand -hex 32)|" .env && rm -f .env.bak
    echo "Created .env from .env.example with a new TULA_MASTER_KEY. Set TULA_ADMIN_TOKEN to use the dashboard."
  fi
fi

[ -d node_modules ] || bun install

docker compose up -d --wait postgres redis mailpit
bun run db:migrate

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

bun run dev &
pids+=($!)
bun run dashboard:dev &
pids+=($!)

# Exit as soon as either process dies, so a failure is visible instead of half a stack.
# (Polling, not `wait -n`: macOS ships bash 3.2.)
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do sleep 1; done
