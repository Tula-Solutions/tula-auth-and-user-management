<!-- Fill every section from the actual diff. Delete a section only if it genuinely does not apply. -->

## 📝 Summary

<!-- What this PR does and why. -->

## 🔨 What changed

-

## 🧩 New module / endpoint

- [ ] Module follows `router.ts` / `service.ts` / `schema.ts` and is registered in `apps/api/src/index.ts`
- [ ] Every route has `describeRoute()` with `operationId`, `tags`, `summary`, `responses`
- [ ] New infra dependencies go through a port in `apps/api/src/ports/` with a memory adapter for tests
- [ ] Tenant tables carry `project_id` / `environment_id` and are covered by RLS
- [ ] `bun run contract:generate` run and `packages/contract/openapi.json` committed

## 🧪 Testing

- [ ] `bun run verify` passes locally
- [ ] Regression test added for every bug fixed / review finding addressed
- [ ] Manual testing (describe):

## 🦦 Ollie review

<!-- Final otterbot-review verdict from /review-loop, plus findings fixed / dismissed (with reason) / deferred (issue link). -->

## 🔐 Security impact

<!-- Auth surface touched? Token, crypto, session, rate-limit or PII changes? Write "None" if not applicable. -->

## 📚 Documentation

- [ ] JSDoc on every new/changed export
- [ ] `AGENTS.md` / `.claude/rules` / README updated if conventions changed

## 💥 Breaking changes

<!-- Contract changes consumers (SDKs, dashboard) must adapt to, or "None". -->

## 🔗 Additional context

<!-- Linked issues, rollout notes. -->
