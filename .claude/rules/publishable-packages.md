---
paths:
  - "packages/**"
  - "scripts/**"
---

# Publishable packages

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Publishable packages (see ADR 0020)

- `exports` point at `./src/*.ts`, so the workspace resolves packages from source with no build
  step. `publishConfig.exports` point at `./dist/*`; `scripts/packages.ts` applies them when it
  stages a package for packing. Add an entry point to **both**.
- Build with `bunup` (ESM, `.d.ts`, dependencies external). Use relative imports inside a
  publishable package, not `~/`: other packages typecheck its sources under their own paths.
- A change to a publishable package comes with a changeset (`bunx changeset`).
- **`@tula/core` must not pull Zod into an application's bundle.** Import run-time values from
  the contract's Zod-free entry points (`@tula/contract/error-codes`, `/event-types`,
  `/headers`, `/password-rules`, `/theme`, `/issuer`, `/webhook-signature`, `/custom-claims`, `/device-binding`) and types from
  `src/generated`. Anything
  an SDK needs at run time goes in a contract module that does not import Zod.
  `packages/contract/src/entry-points.test.ts` bundles every subpath but the index and fails
  for one that reaches Zod, and for a subpath missing from `exports`,
  `publishConfig.exports` or `bunup.config.ts`.
- `@tula/core` ships no Node or Bun API: `typecheck:portable` checks its sources against web
  platform types only.
- **`@tula/admin` is Zod-free at run time and server-side only.** It refuses a publishable key,
  refuses to be created where `window` and `document` exist, and its published `browser`
  export condition resolves to a module that throws. The secret key lives in a closure: never
  a property, an error, a log line or a `toJSON`; redirects are not followed. Plain `http:`
  is refused except for loopback hosts unless `allowInsecureHttp` is set (`@tula/nextjs`
  does the same when it holds a secret key), and a path parameter that is not a single path
  segment (empty, `.`, `..`, a slash, a control character) is refused before any request.
- A package whose declaration build would compile files outside its own tree (tests importing
  another package's sources by path) gives bunup a `tsconfig.build.json` that excludes them
  (`preferredTsconfig`); otherwise stray `.d.ts` files appear next to those sources.
