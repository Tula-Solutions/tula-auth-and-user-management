---
paths:
  - "apps/dashboard/**"
---

# Frontend rules (payhub-portal conventions)

These are for the dashboard application. `packages/react` is a library with different
constraints (no Tailwind, no generated API hooks, `bun test`): see `sdk.md`.

- Vite + React 19, TanStack Router + Query, Tailwind v4 + shadcn, Zustand for client state.
- API access only through Orval-generated hooks from `/v1/openapi.json` (`bun run codegen`).
  Never call `fetch`/axios directly from components.
- `components/ui/**` is shadcn-owned: wrap or extend, never edit.
- kebab-case files, `use-*` hooks, `function` declarations, JSDoc on exported components/hooks.
- Theme via CSS variables generated from the shared design tokens. No hard-coded brand colours.
- Every interactive element must be keyboard-accessible and labelled. The password checklist
  renders from the server-provided policy (`evaluatePassword` from `@tula/contract`).
- Tests: Vitest + Testing Library, colocated.
