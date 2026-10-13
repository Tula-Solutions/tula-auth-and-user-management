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

- **Eleven packages are built for npm; nine are released and two are held back**
  ([docs/releasing.md](../../docs/releasing.md)). The lists are in
  `scripts/publish-manifest.ts`: `PUBLISHABLE_PACKAGES` (all eleven, built and checked by
  `packages:check`), `HELD_PACKAGES` (`@tula-tech/expo` and `@tula-tech/expo-screens`: built and
  checked, never published, `"private": true`) and `RELEASED_PACKAGES`, derived from the
  two. **Only a released package is without `"private": true`**: never remove the field
  from a held-back or private package, and never add a package to the release without its
  `repository`, `homepage`, `bugs` and `keywords`. **A released package never depends at run
  time on a workspace package that is not released** (`dependencies`, `peerDependencies`,
  `optionalDependencies`; `packages:check` stops for one, by name whatever its range).
  `create-tula` keeps the held-back names itself (`UNRELEASED_TULA_PACKAGES`) and refuses a
  template that needs one unless the packages come from tarballs; `@tula-tech/mcp` keeps
  them too (`packages/mcp/src/unreleased.ts`) and its scaffold tools answer
  `scaffold.not_released` for a framework that needs one; `release.test.ts` holds the
  three lists equal.
- **An upload happens in one place**: the loop at the end of `scripts/packages.ts`, over
  what `uploadCommands` (`scripts/release.ts`) returns. It is empty without the explicit
  `--publish` (the dry run is the default; an unknown argument is refused; the
  `release:dry-run` script carries `--dry-run` itself, so that an appended `--publish` is
  refused), and while any
  refusal stands (version `0.0.0` or not an `-alpha.N`, a tree that is not clean or a
  commit that moved, a packed manifest that is private or has a `workspace:` range, a
  registry that did not answer, **a version that is on the registry with another
  `dist.integrity` than the tarball this run built**: a release is never topped up from
  another commit). Only a `.tgz` directly inside `.release/` is ever passed
  to a publish command, never a package directory. **The script holds and reads no stored
  credential**: no `.npmrc`, no token, and of the
  environment only whether a variable is set. **A one-time password (`--otp <code>`) is the
  one thing it is handed**: from the arguments only, never a variable or a file, 6 to 8
  digits, refused in CI, one element of the argument vector, and printed nowhere (every
  line about an upload command goes through `printableCommand`; a refused value is not
  repeated in the error). Never add a second path that uploads
  (`changeset publish`, a publish command in a workflow or a `package.json` script), and a
  new refusal or a change to the gate gets a row in `.claude/hooks/release-publish.test.ts`.
- **`bun publish` on a person's machine, `npm publish --provenance` in the release
  workflow**: the one use of npm in the repository, because Bun's publish has no provenance
  and no trusted publishing. The workflow holds no long-lived token and never gets one
  (`NPM_TOKEN`, `NODE_AUTH_TOKEN`, any `secrets.`); its `publish` job alone has
  `id-token: write`, runs only when the repository variable `NPM_PUBLISH` is `true`, and
  runs in the GitHub environment `npm-publish` (deployment branch `main` only, required
  reviewers; npm's trusted publisher names it). Never remove the `environment:` line:
  without it npm trusts `release.yml` on any ref.
- **A sample never runs a bare `tula` where the CLI may not be installed.** An unrelated
  npm package named `tula` exists, so `bunx tula` / `npx tula` is shown only after the
  install of `@tula-tech/cli@alpha` (or, for a scaffolded project, after `bun install`),
  and a command a client runs outside a project is `bunx --package @tula-tech/cli@alpha
  tula …`. Every install or run of a Tula package from npm names `@alpha`: only that
  dist-tag is written. `.claude/hooks/docs.test.ts` holds both.
- `exports` point at `./src/*.ts`, so the workspace resolves packages from source with no build
  step. `publishConfig.exports` point at `./dist/*`; `scripts/packages.ts` applies them when it
  stages a package for packing. Add an entry point to **both**.
- Build with `bunup` (ESM, `.d.ts`, dependencies external). Use relative imports inside a
  publishable package, not `~/`: other packages typecheck its sources under their own paths.
- A change to a publishable package comes with a changeset (`bunx changeset`).
- **`@tula-tech/core` must not pull Zod into an application's bundle.** Import run-time values from
  the contract's Zod-free entry points (`@tula-tech/contract/error-codes`, `/event-types`,
  `/headers`, `/password-rules`, `/theme`, `/issuer`, `/webhook-signature`, `/custom-claims`, `/device-binding`) and types from
  `src/generated`. Anything
  an SDK needs at run time goes in a contract module that does not import Zod.
  `packages/contract/src/entry-points.test.ts` bundles every subpath but the index and fails
  for one that reaches Zod, and for a subpath missing from `exports`,
  `publishConfig.exports` or `bunup.config.ts`.
- `@tula-tech/core` ships no Node or Bun API: `typecheck:portable` checks its sources against web
  platform types only.
- **`@tula-tech/admin` is Zod-free at run time and server-side only.** It refuses a publishable key,
  refuses to be created where `window` and `document` exist, and its published `browser`
  export condition resolves to a module that throws. The secret key lives in a closure: never
  a property, an error, a log line or a `toJSON`; redirects are not followed. Plain `http:`
  is refused except for loopback hosts unless `allowInsecureHttp` is set (`@tula-tech/nextjs`
  does the same when it holds a secret key), and a path parameter that is not a single path
  segment (empty, `.`, `..`, a slash, a control character) is refused before any request.
- A package whose declaration build would compile files outside its own tree (tests importing
  another package's sources by path) gives bunup a `tsconfig.build.json` that excludes them
  (`preferredTsconfig`); otherwise stray `.d.ts` files appear next to those sources.
