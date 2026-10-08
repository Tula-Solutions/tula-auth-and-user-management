# Releasing

**Nothing is published yet.** The licence is decided: Apache-2.0 for the whole repository
([`LICENSE`](../LICENSE)). The npm scope is not (Phase 1 plan, Decision 2). Everything below is
built and exercised as a dry run only. The design is in
[ADR 0020](adr/0020-packaging-and-release.md).

## Publishable packages

| Package | What |
| --- | --- |
| `@tula/contract` | Schemas, flow protocol, error codes, token claims, password policy. |
| `@tula/core` | The headless TypeScript client. |

The list lives in `scripts/publish-manifest.ts` (`PUBLISHABLE_PACKAGES`), dependencies first.
Every other workspace package is private for good.

### `@tula/contract` under a strict Content-Security-Policy

`@tula/contract`'s main entry point uses Zod, and Zod finds out whether it may compile its
parsers with `new Function` by trying. On a page whose policy has no `'unsafe-eval'` the
attempt is refused and reported as a violation (nothing breaks: Zod then uses its
interpreter). An application under such a policy should switch the attempt off **before**
the contract is imported: `import { config } from 'zod'; config({ jitless: true })` in a
module that the entry point imports first (the dashboard's `src/lib/zod-csp.ts`), or, for a
bundle that carries its own copy of Zod, `globalThis.__zod_globalConfig = { jitless: true }`
in a script that runs before it. The Zod-free entry points (`/error-codes`, `/headers`,
`/password-rules`, `/theme`, `/issuer`) need nothing.

## How a package is built and checked

```bash
bun run build              # bunup in every package that has a build script (ESM + .d.ts → dist/)
bun run packages:check     # build → stage → pack → publint → arethetypeswrong   (part of verify)
bun run release:dry-run    # the same, then report what a release would publish
```

Inside the repository a package's `exports` point at its TypeScript sources, so Bun, `tsc`, the
tests and the Docker image use workspace packages without building anything. The published
manifest is different: `scripts/packages.ts` stages each package in `.release/<name>/` with the
fields of its `publishConfig` (the `dist/` entry points) in place of the source ones, without
`scripts` and `devDependencies`, and with `workspace:*` ranges replaced by real versions. It
then packs that directory with `bun pm pack` and runs both checkers on the tarball:

- **publint** (`--strict`): every entry point exists, has types and follows npm's rules.
- **arethetypeswrong** (`--profile esm-only`): the types resolve under each module resolution
  mode. The packages are ESM-only on purpose; CommonJS `require` is out of scope.

To look at exactly what would be published: `tar -tzf .release/tula-core-<version>.tgz`.

## Versions and changelogs

Changesets (`.changeset/`). A change to a publishable package comes with a changeset:

```bash
bunx changeset           # which packages, which bump, the changelog line
bunx changeset status    # what the next release would contain
```

- `@tula/contract`, `@tula/core`, `@tula/react`, `@tula/nextjs`, `@tula/admin`, `@tula/config` and `@tula/cli` are a **fixed** group: they always share one version. The
  client is written against one version of the protocol, so "0.1.0 of the SDK" should mean one
  thing.
- The repository is in **prerelease mode** (`.changeset/pre.json`, tag `alpha`). The pending
  changeset bumps both packages from `0.0.0` to `0.1.0-alpha.0`; each further one gives
  `-alpha.1`, `-alpha.2`, … Leave prerelease mode with `bunx changeset pre exit`.
- `bunx changeset version` applies the pending changesets: it rewrites the versions and writes
  each package's `CHANGELOG.md`. It is run on the release branch by whoever cuts the release
  and is committed like any other change. It has not been run yet.
- `@tula/api`, `@tula/db` and `@tula/conformance` are ignored by Changesets: they are never
  published and have no version to speak of.

## The release workflow

`.github/workflows/release.yml` runs on every push to `main` (git-flow: `main` is release-only).
It installs, prints `changeset status`, runs `bun run release:dry-run`, fails if any package is
not private, and uploads the tarballs as a build artifact for inspection. It has no credentials
and only `contents: read`.

## Turning publishing on

Publishing cannot happen by accident. Four independent things stop it, and a guardrail test
(`.claude/hooks/release.test.ts`, part of `bun run test:harness`) fails if any of the first
three changes without the test being changed too:

1. Every package is `"private": true`; npm refuses to publish a private package.
2. `scripts/packages.ts` has no code path that uploads anything.
3. The workflow has no npm token, no `id-token: write`, and a step that fails when a package
   is not private.
4. `.changeset/config.json` has `"access": "restricted"`.

When the scope is decided, the change that turns publishing on is, in order:

1. Add the `repository` and `homepage` fields to each publishable package. The `license`
   field is there, and the staging step copies `README.md` and the repository's `LICENSE`
   into the tarball.
2. If the scope changes, rename the packages (and `PUBLISHABLE_PACKAGES`, the `fixed` group and
   every import).
3. Remove `"private": true` from the publishable packages only.
4. Set `"access": "public"` in `.changeset/config.json`.
5. Add the publish step to `scripts/packages.ts` (`release` mode): `npm publish <tarball>
   --provenance --tag alpha` for each package, dependencies first. Publish the **staged
   tarball**, not the package directory: only the staged manifest has the `dist/` entry points.
6. In `release.yml`: add `id-token: write` (npm trusted publishing, no long-lived token), and
   delete the "No package may be publishable yet" step.
7. Update `.claude/hooks/release.test.ts` to the new rules, and this document.

Do them in one reviewed pull request.
