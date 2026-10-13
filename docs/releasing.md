# Releasing

Nine packages are released to npm as alphas (dist-tag `alpha`, first version
`0.1.0-alpha.0`); two are built and checked and **held back**. The licence is Apache-2.0 for
the whole repository ([`LICENSE`](../LICENSE)). The npm scope is decided: `@tula-tech`, the
owner's npm organisation (`create-tula` is unscoped). The design is in
[ADR 0020](adr/0020-packaging-and-release.md).

**The first release is made by a person, from their machine** ([First release](#first-release)):
the release workflow has no token and publishes through npm trusted publishing, which npm
only lets you configure for a package that already exists. After that the workflow takes
over, once a repository variable is set. Merging a change publishes nothing by itself.

## The packages

| Package | What | State |
| --- | --- | --- |
| `@tula-tech/contract` | Schemas, flow protocol, error codes, token claims, password policy. | Released |
| `@tula-tech/core` | The headless TypeScript client. | Released |
| `@tula-tech/react` | Provider, hooks and prebuilt components. | Released |
| `@tula-tech/nextjs` | The Next.js App Router SDK. | Released |
| `@tula-tech/admin` | The typed client of the admin API. Server-side only. | Released |
| `@tula-tech/config` | `defineConfig()` for `tula.config.ts`. | Released |
| `@tula-tech/mcp` | The Model Context Protocol server `tula mcp` serves. | Released |
| `@tula-tech/cli` | The `tula` command line. Runs on Bun. | Released |
| `create-tula` | Scaffolds a project. Runs on Bun. | Released |
| `@tula-tech/expo` | The headless Expo SDK. | **Held back**: never run on a device, in a simulator or in an emulator. |
| `@tula-tech/expo-screens` | The native screens as Expo components. | **Held back**: its iOS module was never compiled and no screen was drawn through it. |

A package is in one of three states, and the lists live in `scripts/publish-manifest.ts`:

- **Released** (`RELEASED_PACKAGES`): built, checked and published. Not `"private"`.
- **Held back** (`HELD_PACKAGES`): built and checked by `packages:check` exactly like a
  released one, so it cannot rot, and never published. It stays `"private": true`, so npm
  itself refuses it whatever a script does.
- **Private**: everything else in the workspace (the API, the database package, the
  dashboard, the examples). Never built for npm.

`PUBLISHABLE_PACKAGES` is the released and the held-back ones together, dependencies first;
`RELEASED_PACKAGES` is derived from the other two. **Releasing a held-back package** is:
delete its line in `HELD_PACKAGES`, remove `"private": true` from its manifest, add
`repository`, `homepage`, `bugs` and `keywords` to it, and take its name out of
`UNRELEASED_TULA_PACKAGES` in `packages/create-tula/src/scaffold.ts`. The guardrail test
fails until those agree.

**A released package never depends at run time on one that is not.** `packages:check` stops
for a `dependencies`, `peerDependencies` or `optionalDependencies` entry of a released
package that names a held-back or private workspace package, by name, whatever its range:
a consumer could not install it. `devDependencies` do not count (the published manifest has
none). Today none of the nine does.

The Swift package and the Kotlin libraries are not npm packages and are published nowhere.
**No Tula API image is published either**: a project still builds it from this repository
([self-host.md](self-host.md)).

### What `create-tula` does about the held-back packages

Its `expo` template's app names `@tula-tech/expo`, which is not on npm, so the project could not
be installed. `create-tula --framework expo` is therefore refused, before anything is
written, with a message that says so, unless `--tula-packages <dir>` points it at tarballs
from a checkout (`bun run packages:check` writes them to `.release/`). The web templates
install from npm. `swiftui` and `compose` name their SDK by a path into a checkout
(`--tula-repo`), as before.

### `@tula-tech/contract` under a strict Content-Security-Policy

`@tula-tech/contract`'s main entry point uses Zod, and Zod finds out whether it may compile its
parsers with `new Function` by trying. On a page whose policy has no `'unsafe-eval'` the
attempt is refused and reported as a violation (nothing breaks: Zod then uses its
interpreter). An application under such a policy should switch the attempt off **before**
the contract is imported: `import { config } from 'zod'; config({ jitless: true })` in a
module that the entry point imports first (the dashboard's `src/lib/zod-csp.ts`), or, for a
bundle that carries its own copy of Zod, `globalThis.__zod_globalConfig = { jitless: true }`
in a script that runs before it. The Zod-free entry points (`/error-codes`,
`/event-types`, `/headers`, `/password-rules`, `/theme`, `/issuer`) need nothing.

## How a package is built and checked

```bash
bun run build              # bunup in every package that has a build script (ESM + .d.ts → dist/)
bun run packages:check     # build → stage → pack → publint → arethetypeswrong   (part of verify)
bun run packages:states    # only: is every package's "private" field what its state says
bun run release:dry-run    # packages:check, then report what a release would publish
bun run release:publish    # the same, then upload what the registry does not have
```

Inside the repository a package's `exports` point at its TypeScript sources, so Bun, `tsc`, the
tests and the Docker image use workspace packages without building anything. The published
manifest is different: `scripts/packages.ts` stages each package in `.release/<name>/` with the
fields of its `publishConfig` (the `dist/` entry points) in place of the source ones, without
`scripts` and `devDependencies`, and with `workspace:*` ranges replaced by real versions. It
then packs that directory with `bun pm pack` and checks the tarball:

- **publint** (`--strict`): every entry point exists, has types and follows npm's rules.
- **arethetypeswrong** (`--profile esm-only`): the types resolve under each module resolution
  mode. The packages are ESM-only on purpose; CommonJS `require` is out of scope.
- **What must not ship**: the package's own `src/`, a test in `dist/`, `node_modules`, an
  `.npmrc`, an environment file other than `.env.example`.
- **The manifest inside the tarball**, for a released package: not private, no `workspace:`
  range, no `scripts`, `devDependencies` or `publishConfig`, every entry point in `dist/`.

To look at exactly what would be published: `tar -tzf .release/tula-tech-core-<version>.tgz`.

## Versions and changelogs

Changesets (`.changeset/`). A change to a publishable package comes with a changeset:

```bash
bunx changeset                     # which packages, which bump, the changelog line
bunx changeset status --verbose    # what the next release would contain, and its version
```

- The eleven publishable packages are a **fixed** group: they always share one version. The
  client is written against one version of the protocol, so "0.1.0 of the SDK" should mean one
  thing. **The two held-back packages stay in the group**: with
  `privatePackages: { version: true, tag: false }` their version and changelog move with the
  others' and they are never tagged or published, so the day one is released it is already
  at the group's version.
- `"access": "public"`: a scoped package is published for everyone to install. Nothing runs
  `changeset publish`; the upload is `scripts/packages.ts`, which passes `--access public`
  itself.
- The repository is in **prerelease mode** (`.changeset/pre.json`, tag `alpha`). The pending
  changesets take every package from `0.0.0` to `0.1.0-alpha.0`; each further release gives
  `-alpha.1`, `-alpha.2`, … Leave prerelease mode with `bunx changeset pre exit`.
- `bunx changeset version` applies the pending changesets: it rewrites the versions and writes
  each package's `CHANGELOG.md`. It is run on the release branch by whoever cuts the release
  and is committed like any other change.
- `@tula-tech/api`, `@tula-tech/db` and `@tula-tech/conformance` are ignored by Changesets: they are never
  published and have no version to speak of.

## What the publish step does, and refuses

`bun run release:publish` is `scripts/packages.ts release --publish`. **Without `--publish`
it is the dry run**, which is the default; any other argument is refused, never read as the
default. `bun run release:dry-run` is `release --dry-run`, spelled out, because Bun appends
whatever follows a script's name: `bun run release:dry-run --publish` is then both flags at
once, which is refused ("choose one"), and not an upload. The decisions are pure functions in
`scripts/release.ts`, tested in `.claude/hooks/release-publish.test.ts`.

In order, it:

1. Checks every workspace package's `private` field against its state, and that no released
   package needs an unreleased one at run time.
2. Notes the commit and whether the tree is clean, then builds, stages, packs and checks all
   eleven packages afresh into `.release/` (nothing from an earlier run is reused).
3. Asks the registry, with a plain unauthenticated `GET
   https://registry.npmjs.org/<name>/<version>`, which of the nine versions already exist.
   A 200 is "there", a 404 is "not there", and anything else is "unknown", which stops an
   upload. **A version that is there is skipped only when it is the same tarball**: the
   registry's `dist.integrity` for it must equal the SHA-512 of the tarball this run built.
   So a run that failed half-way is run again **from the same commit**, and the tarballs
   are the same (two builds of one commit gave identical checksums for all nine, on one
   machine; a build on another machine was not compared). A version that is there with
   other contents refuses the whole run: a release is finished from the commit it started
   from, or a new version is cut. Without this, a fix committed after four packages went
   out would publish the other five from a different commit under the same version.
4. Prints the report: each package with its version, tarball, size, file count, dist-tag and
   SHA-256, what would be skipped, how the upload would be done, and every reason it would
   be refused.
5. With `--publish` and no refusal, uploads each remaining package's **staged tarball**,
   `create-tula` first and then the scoped packages, dependencies first, with `--access
   public --tag alpha`. The unscoped one goes first because it is the one upload the
   registry check cannot vouch for ([First release](#first-release), step 1): if npm
   refuses it, nothing else has gone out. Before each upload it checks
   again that the commit, the tree and the tarball's checksum are what was checked.

It refuses to upload (and the dry run says "a publish would be refused") when:

- the version is `0.0.0`, the released packages do not share one version, or the version is
  not an `-alpha.N` prerelease (the script only ever writes the `alpha` dist-tag; `latest`
  is never moved);
- the git tree had uncommitted or untracked files before the build or has them after it, or
  the commit changed during the run;
- a packed manifest is private or has a `workspace:` range left, or a package of the release
  asks for another at a different version, or the order is not dependencies first;
- the registry did not answer for a package, or has a version of it with other contents
  than the tarball this run built;
- `--otp` was given in CI (`GITHUB_ACTIONS` or `CI` is set);
- in GitHub Actions: the job has no OIDC identity, npm is missing or older than 11.5.1, or
  `NPM_TOKEN` or `NODE_AUTH_TOKEN` is set. In a dry run these three are printed as a
  "note, not checked in a dry run" and not as a refusal: the workflow's `dry-run` job has
  no OIDC identity on purpose, and only the job that uploads needs one.

It is never given a package directory: only a `.tgz` directly inside `.release/` is passed to
a publish command. A package's own directory has the repository's manifest, whose `exports`
point at sources that are not in `files`.

**No stored credential passes through the script.** It reads no `.npmrc`, takes no token,
and looks at the environment only to see whether a variable is set. The package manager it
starts uses its own login and, by default, owns the terminal while it runs: it asks for the
second factor itself.

**The one thing it can be handed is a one-time password**, `--otp <code>` after
`--publish`, for a session with no terminal to be asked in. The code must be 6 to 8 digits;
it is taken from the arguments only (never a variable or a file), refused in CI, passed to
the publish command as an argument of its own, and **kept out of the script's own output**:
the command line is shown with `******` in its place, and a mistyped value is not repeated
in an error (digits typed without the flag are not either). The script cannot answer for
what starts it: **`bun run` prints the command it starts**, arguments included
(`$ bun run scripts/packages.ts release --publish --otp "123456"`), before the script has
run a line. So the command is `bun run --silent release:publish --otp <code>`: with
`--silent` Bun prints no such line (both seen by running a scratch script on Bun 1.4.2). With
a code the publish command is given no input at all, so a code that npm refuses ends the
run instead of leaving a prompt waiting. A code typed as an argument is in your shell's
history and in the process list while the command runs; it is worth nothing once it has
been used or has expired.

### Which CLI uploads

The repository's rule is Bun only, and there is **one exception, in one place**:

| Where | Command | Why |
| --- | --- | --- |
| A person's machine | `bun publish <tarball> --access public --tag alpha` | Bun's own publish. No provenance: an attestation can only be made in a supported CI. |
| The release workflow | `npm publish <tarball> --access public --tag alpha --provenance` | `bun publish` (1.4) has no `--provenance` and no trusted publishing; npm's needs npm 11.5.1 or later. |

Checked by running, on Bun 1.4.2 and npm 11.8.0: `bun publish --help` lists `--access`,
`--tag`, `--otp`, `--auth-type` and a tarball argument, and no provenance option; `bun
publish --dry-run <tarball>` and `npm publish --dry-run <tarball>` both read the staged
tarball, report the same shasum, and Bun refuses one whose manifest is private. **Not run**:
a real upload by either, `npm publish --provenance` (it has no meaning outside CI), and
trusted publishing, which is taken from npm's documentation.

About the second factor, **read and not run** (nothing has been uploaded, so no prompt was
ever seen): `bun publish --help` says `--otp=<val>` "Provide a one-time password for
authentication" and `--auth-type=<val>` "Specify the type of one-time password
authentication (default is 'web')". So without `--otp` Bun's default is npm's web flow, an
address to approve in a browser; whether it needs a terminal to show it, and whether one
code is accepted for several uploads in a row, is not known.

## The release workflow

`.github/workflows/release.yml` runs on every push to `main` (git-flow: `main` is
release-only). It has two jobs:

- **`dry-run`**, always: installs, prints `changeset status`, runs `bun run packages:states`
  and `bun run release:dry-run`, and uploads the tarballs as a build artifact for
  inspection. It can only read the repository.
- **`publish`**, only when the repository variable `NPM_PUBLISH` is `true`: runs `bun run
  release:publish` with `id-token: write`, which is what npm trusted publishing and
  provenance use, **in the GitHub environment `npm-publish`**. There is no npm token in the
  repository's secrets, and none may be added.

**Why the environment.** npm's trusted publisher is a claim about a GitHub run: the
repository, the workflow file and, when one is given, the environment. With no environment
the claim is "`release.yml` of this repository" on **any ref**: someone who can push a
branch can push it with a copy of the workflow that triggers on that branch and publishes
what they like, once `NPM_PUBLISH` is on. The environment closes that: GitHub lets only
`main` deploy to `npm-publish` and asks a reviewer first, and npm accepts only a run that
carries the environment's name. The workflow file can only name the environment; its rules
are a setting of the repository, made by a person ([First release](#first-release), step
8), and no test here can see them.

## What stops a publish that was not meant

Each of these is independent, and the guardrail tests (`.claude/hooks/release.test.ts` and
`release-publish.test.ts`, part of `bun run test:harness`) fail when one changes without the
test being changed too:

1. Only the nine released packages are not `"private": true`. A held-back or private package
   that loses the field fails `packages:check`, the workflow and the test; npm refuses a
   private package in any case.
2. The script uploads in one place, only with the explicit `--publish`, only staged tarballs,
   and only when nothing is refused.
3. The workflow has no long-lived token (`NPM_TOKEN`, `NODE_AUTH_TOKEN`, any `secrets.`), no
   publish command of its own, `id-token: write` on the one job that publishes, and that job
   is off until `vars.NPM_PUBLISH` is `true` and runs in the environment `npm-publish`.
   **One part of this is a setting and not a file**: the branch restriction of the
   `npm-publish` environment (`main` only) and its required reviewers. Check them by hand
   whenever the repository's settings change.
4. The script refuses to upload from a GitHub Actions job that holds a token.

## First release

For the owner, once. Everything before step 6 changes nothing on npm.

1. **The npm scope.** On [npmjs.com](https://www.npmjs.com), create or confirm the
   organisation that owns the scope the packages are published under (`@tula-tech`), and that your
   account may publish to it. An unscoped name (`create-tula`) needs no organisation, only to
   be free. If the scope is not yours, stop: the packages have to be renamed first.

   **`create-tula`, if it was ever published.** npm never accepts again a version that once
   existed, also after it was unpublished, and the registry does not say that one did: on
   2026-10-13 `GET https://registry.npmjs.org/create-tula` answered `404 {"error":"Not
   found"}` and `…/create-tula/0.1.0-alpha.0` `404`, with no list of earlier versions
   (asking npm for the package's version history is the same 404). The Phase 2 plan's note of
   2026-10-08 says the name was "unpublished on npm" and names no version; read with its
   sentence it means "not published", but that is a reading. So: **if you, or anyone with
   the name, ever published and removed `create-tula@0.1.0-alpha.0`, that version is gone
   for good, and the release must be cut as `-alpha.1`** (`bunx changeset version` again
   on the release branch). You are the only one who can know. The script cannot see it,
   which is why it uploads `create-tula` first: a refusal then comes before any other
   package is out.
2. **Sign in on your machine**, with two-factor authentication switched on for the account:

   ```bash
   bunx npm login          # the login `bun publish` uses; `bun pm whoami` shows who you are
   ```

3. **Cut the release branch** (git-flow) from `develop` and apply the changesets:

   ```bash
   git switch -c release/0.1.0-alpha.0 origin/develop
   bunx changeset version                 # versions → 0.1.0-alpha.0, writes each CHANGELOG.md
   ```

   Three constants hold the version by hand: `VERSION` in
   `packages/create-tula/src/scaffold.ts` (also the version a scaffolded project pins its
   `@tula-tech/*` packages to) and in `packages/cli/src/version.ts`, and `MCP_VERSION` in
   `packages/mcp/src/server.ts`. Set them to the new version, then:

   ```bash
   bun install                            # the lockfile follows the versions
   bun run verify
   ```

   `verify` fails for a constant that was missed and for a test that still names `0.0.0`.
   This has not been done before (no version has ever been applied), so expect to fix a few
   such places; the tarball names in `docs/quickstart.md` and the examples' READMEs carry
   the old version too.

   Commit, open a pull request **into `main`**, and merge it when CI is green. Merging
   publishes nothing: `NPM_PUBLISH` is not set.
4. **On the merged commit**, with a clean tree:

   ```bash
   git switch main && git pull --ff-only
   bun install --frozen-lockfile
   bun run release:dry-run
   ```

5. **Read the report.** Nine `publish` lines at `0.1.0-alpha.0` with tag `alpha`,
   `create-tula` first, the two Expo packages named as held back, and **no** line saying a
   publish would be refused. Look
   inside a tarball if in doubt: `tar -tzf .release/tula-tech-react-0.1.0-alpha.0.tgz`.
6. **Publish.** Every upload needs your second factor. Which command depends on where you
   sit.

   **At a terminal of the machine itself:**

   ```bash
   bun run release:publish
   ```

   `bun publish` then asks for the second factor itself. Its help gives the web flow as the
   default (an address to approve in a browser); how it asks has not been seen, because
   nothing has been uploaded yet.

   **In a session with no terminal to be asked in** (a remote session, an assistant running
   the command for you), give the code as an argument:

   ```bash
   bun run --silent release:publish --otp 123456      # the digits your authenticator shows now
   ```

   **Keep the `--silent`.** Without it `bun run` prints the command it starts, code
   included, into the session's output before the script begins. The script itself shows
   the code nowhere and stores it nowhere; it is still in your shell's history and in the
   process list while the command runs
   ([what the publish step does](#what-the-publish-step-does-and-refuses)).

   **Whether one code serves all nine uploads is not known**: it was not tried, a code lasts
   about thirty seconds, nine uploads may take longer, and npm may refuse a code it has
   already accepted. So expect the run to publish what the code allows and then stop,
   naming the package that failed. Run the same command again with the code your
   authenticator shows then, and again, until it reports that everything is on the
   registry. Each run skips what is already there, after comparing it with the tarball it
   just built, so repeating is safe.

   Either way it builds again, prints the same report and uploads `create-tula` first and
   then the scoped packages, dependencies first. If it stops half-way for another reason,
   fix the cause and run it again **from the same commit**: a fix that needs a new commit
   needs a new version too, and the script refuses to top a release up from another
   commit. There is no provenance on this first release.
7. **Check.** `bun info @tula-tech/core@alpha` shows the version, and in an empty directory
   `bunx create-tula@alpha my-app --framework react-vite && cd my-app && bun install` installs.

   **Compare one integrity, as soon as the first package is up, and write the result
   here.** Nobody has verified that `bun publish <tarball>` (or `npm publish <tarball>`)
   uploads the tarball's bytes unchanged. Run `bun run release:dry-run` again from the same
   commit: a package that is up must read `skip … (already on the registry, the same
   tarball)`. If it reads `DIFFERS`, the CLI repacked what it was given: every run after
   the first would then refuse (it fails closed, nothing wrong is uploaded), and the
   comparison has to be changed before the release can be finished.

   **Then run the same two commands once more without the `@alpha`, and write here what
   they did.** The release writes the `alpha` dist-tag and nothing else; whether npm also
   points `latest` at the first version of a new package published with `--tag alpha` was
   not verified. Until the answer is written down, every sample in the docs names the tag
   (`.claude/hooks/docs.test.ts` holds them to it).
8. **Hand over to the workflow.** Three things, in this order.

   **The environment.** In the GitHub repository, Settings → Environments, create an
   environment named `npm-publish`. Set its deployment branches to "Selected branches" with `main` only,
   and add yourself under required reviewers. The `publish` job runs in it: a run waits
   for your approval, and GitHub refuses one from any other branch.

   **npm.** For **each** of the nine packages, on npmjs.com → the package → Settings →
   Trusted Publisher, add GitHub Actions with the organisation `Tula-Solutions`, the
   repository `tula-auth-and-user-management`, the workflow file `release.yml` and
   the environment `npm-publish`. The environment's name is what ties npm's trust to `main`:
   left empty, npm trusts that workflow file on every ref, and whoever can push a branch
   could publish from it ([why](#the-release-workflow)).

   **The switch.** Only then, Settings → Secrets and variables → Actions → Variables, add
   `NPM_PUBLISH` = `true`. From the next push to `main` the `publish` job uploads whatever
   the registry does not have, with provenance, after you approve the run.

   Check by hand, because no file of the repository holds it: the branch restriction of the
   `npm-publish` environment says `main` and nothing else, the reviewer is you, and each of
   the nine trusted publishers names the environment.
9. **Merge `main` back into `develop`**, so the versions and changelogs are there too.

A later release is steps 3, the merge, and nothing else: the workflow publishes. Unpublishing
is not part of this: a bad alpha is followed by the next one (`npm deprecate` marks the old
one).
