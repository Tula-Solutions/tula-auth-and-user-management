---
name: new-module
description: Scaffold a new Tula API module in apps/api/src/modules/<name>/ with router.ts, service.ts, schema.ts and tests following the hybrid payhub pattern, and register its routes. Use when adding a new API feature or endpoint group.
argument-hint: <kebab-name> [client|admin]
---

# New API module

Arguments: `$ARGUMENTS`. The first word is the kebab-case module name; the second is the route
group (`client` by default, or `admin`).

1. **Read first:** `AGENTS.md` (API module pattern), `.claude/rules/api.md`, and the closest
   existing module in `apps/api/src/modules/` to copy its shape.
2. **Contract first:** if the module introduces request/response shapes, flow steps or error codes
   that clients will see, add them to `packages/contract` (run `/contract-change`).
3. **Create `apps/api/src/modules/<name>/`:**
   - `schema.ts`: Zod schemas with `.meta({ ref })`, re-exporting contract shapes where they exist.
   - `service.ts`: exported functions taking `deps: Pick<Deps, ...>` first, with JSDoc on each.
     If you need new infrastructure, add a port in `src/ports/`, a memory adapter, and the real
     adapter, and wire them in `container.ts` and `createTestDeps()`.
   - `router.ts`: default-export a Hono router. Every route has `describeRoute({ operationId,
     tags, summary, security, responses })`, `validator(...)` and the right key middleware.
   - `service.test.ts`: written **before** the service body. Happy path plus every failure path.
   - `router.test.ts`: at least one `createApp(createTestDeps()).request(...)` test per route.
3b. If this is a new **package** (not a module), give it a `bunfig.toml` with `coverageThreshold`.
4. **Register** the router in `apps/api/src/index.ts` with a lazy import under
   `/v1/<group>/<name>`.
5. Run `bun run contract:generate`, then `/verify`, then `/review-loop`.
