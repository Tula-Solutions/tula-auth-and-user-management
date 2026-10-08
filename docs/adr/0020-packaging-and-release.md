# ADR 0020 — Packaging and release tooling

- Status: accepted
- Date: 2026-10-03

## Context

Phase 1 produces the first packages other people install: `@tula/contract` and `@tula/core`,
then `@tula/react`, `@tula/nextjs` and the rest. Until now every workspace package was consumed
as TypeScript source by Bun, and nothing was built. Three things had to be settled before the
first SDK: how a package is built, how the repository keeps working without building, and how
a release is cut. A fourth was already settled: **nothing is published in Phase 1** until the
licence and the npm scope are decided.

## Decision

### Build: bunup, ESM only, nothing bundled

Each publishable package has a `bunup.config.ts` and a `build` script. Output is ESM with
`.d.ts` files in `dist/`, target `browser` (web platform APIs only), dependencies left as
imports. Declarations are generated with the TypeScript compiler (`dts.inferTypes`), because
the contract's types are inferred from Zod schemas and cannot be written as isolated
declarations. No CommonJS build: every supported runtime (browsers through a bundler, Node 20+,
Bun, edge runtimes) loads ESM, and a dual build doubles the ways types can be wrong.

`sideEffects: false` is set, so a bundler drops what an application does not import.

### Inside the repository, packages resolve from source

A package's `exports` point at `./src/*.ts`. Its `publishConfig.exports` point at `./dist/*`.
Nothing in the repository reads `publishConfig`, so `bun test`, `tsc`, `bun run dev` and the
Docker image keep resolving workspace packages from source with no build step and no watcher.

The alternatives were rejected for these reasons:

- **A `bun` or `development` export condition** pointing at the source. TypeScript would need
  `customConditions` in every tsconfig; `bun build --target browser` (the playground, bundle
  measurements) does not apply the `bun` condition and would need `dist/` to exist; and a
  published `bun` condition would give Bun users a different, untested entry point (the
  sources) from everyone else.
- **`exports` pointing at `dist/`**, with `turbo` building dependencies first. Every test run,
  typecheck and the Docker build would depend on a build, and stale `dist/` directories would
  become a class of bug.

The cost is that neither npm nor `bun pm pack` applies `publishConfig.exports` on its own (pnpm
does). So the publish-time manifest is produced by a script, which is also where the checks run:

### `scripts/packages.ts` stages, packs and checks

For each publishable package: build; copy `files`, `README.md` and `LICENSE` into
`.release/<name>/`; write the manifest with `publishConfig`'s fields hoisted, `scripts` and
`devDependencies` dropped and `workspace:` ranges replaced by versions; `bun pm pack`; then
`publint --strict` and `attw --profile esm-only` **on the tarball**. Checking the tarball, not
the directory, is the point: it is the artefact a user installs.

`bun run packages:check` is part of `bun run verify`. It adds about one second.

### Versions: Changesets, a fixed group, prerelease mode

- `@tula/contract` and `@tula/core` are `fixed`: one version for the protocol and the client
  written against it. Later SDK packages join the group. `linked` (versions only move together
  when both change) was the alternative; a single number is easier to support while the
  protocol is still moving.
- Prerelease mode with the `alpha` tag is on; the first changeset takes both packages to
  `0.1.0-alpha.0`. `changeset version` has not been run: applying it is part of cutting a
  release.
- Private packages are versioned but never tagged; the API, the database package and the
  conformance runner are ignored.
- `baseBranch` is `main`, where releases are cut (git-flow).

### The release workflow is a dry run, and cannot publish

`release.yml` runs on push to `main`: `changeset status`, `bun run release:dry-run`, a check
that every package is private, and the tarballs uploaded as an artifact. Publishing is blocked
four independent ways (`private: true`; no upload code in the script; no credentials and
read-only permissions in the workflow; `access: restricted`), and a harness test pins the first
three. [docs/releasing.md](../releasing.md) lists the edits that turn publishing on.

### The contract gets Zod-free entry points

`@tula/core` needs the error-code table, three header names and the password rule engine at
run time. Importing them from `@tula/contract`'s index cost an application **110.9 kB minified,
31.9 kB gzip**, almost all of it Zod: the constants shared modules with schemas. The contract
now keeps them in modules that import nothing (`error-codes.ts`, `headers.ts`,
`password-rules.ts`), re-exported from the index as before and also exposed as subpaths
(`@tula/contract/error-codes`, `/headers`, `/password-rules`). The same three imports now cost
**6.8 kB minified, 2.5 kB gzip**. The change is additive: every existing export is still there.
`PUBLISHABLE_KEY_HEADER` and `CLIENT_HEADER` moved from the API into the contract, since every
SDK needs them.

## Consequences

- A new publishable package needs: `bunup.config.ts`, `exports` + `publishConfig.exports` +
  `files` + `sideEffects`, a `build` script, an entry in `PUBLISHABLE_PACKAGES` and in the
  `fixed` group. The harness test checks the manifest's shape.
- Whoever publishes must publish the staged tarball. Running `npm publish` in a package
  directory would ship a manifest whose `exports` point at sources that are not in `files`;
  `private: true` currently prevents exactly that mistake, and the step that replaces it must
  keep doing so.
- `openapi-typescript` could not be used for the SDK's generated types: it is built on the
  TypeScript 5 compiler API, which TypeScript 7 does not ship. See
  [ADR 0021](0021-core-sdk.md).
- The packed manifests had no `license` field until Decision 1 of the Phase 1 plan was made.
  It was made in October 2026: Apache-2.0 for the whole repository. Every publishable package
  now carries the field and ships the repository's `LICENSE`.
