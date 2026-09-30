---
name: contract-change
description: Safely change the Tula public contract (packages/contract, API routes or response shapes), regenerate the OpenAPI snapshot, update consumers and flag breaking changes. Use when adding or changing error codes, flow steps, token claims, schemas, or any API route.
---

# Contract change

1. Classify the change:
   - **Additive:** new optional field, new endpoint, new error code, new flow step that old
     clients can ignore.
   - **Breaking:** removed or renamed field or code, a field that became required, a changed type
     or meaning. Breaking changes need the user's explicit OK before you implement them.
2. Edit `packages/contract/src/*`. Add `.meta({ ref })` and JSDoc to every new export.
3. Update the API code that produces or consumes the shape.
4. Run `bun run contract:generate` and read the `packages/contract/openapi.json` diff. Every hunk
   must be intended.
5. Update consumers in the same PR: SDK packages, dashboard codegen (`bun run codegen` in
   `apps/dashboard` once it exists) and `conformance/` scenarios.
6. Run `/verify`. In the PR, list breaking changes under "💥 Breaking changes" or write "None".
