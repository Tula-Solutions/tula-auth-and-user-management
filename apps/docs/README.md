# `@tula-tech/docs`

The documentation site: the Markdown of [`docs/`](../../docs/README.md) rendered to static HTML.
Private and never published to npm; it is not in the API image, and the API does not serve it.
It is published to GitHub Pages at
**https://tula-solutions.github.io/tula-auth-and-user-management/** (see
[Where it is published](#where-it-is-published)).

```bash
bun run docs-site:dev      # build, then serve on http://127.0.0.1:4321/ (DOCS_PORT changes the port)
bun run docs-site:build    # build into apps/docs/dist
bun run --filter @tula-tech/docs build:versions   # the released docs at the root and the unreleased ones under next/, as deployed
bun run --filter @tula-tech/docs generate:check   # render everything in memory: what `verify` runs
```

## What it builds

- **A page for every Markdown file of `docs/`**, except `docs/plans/`, `docs/adr/` and
  `docs/codebase-map/`. The Markdown stays the only source; the site holds no copy of it.
- **A landing page** at `/` and the documentation index at `/docs/`.
- **A generated page of error codes** at `/reference/error-codes/`: every code of
  `@tula-tech/contract` with its status and message, each under an `id` equal to the code
  (`#password.too_short`). A code added to the contract is on the page in the same build.
- **A sidebar** from the sections and tables of `docs/README.md`.
- **Search**: `search-index.json`, written at build time, matched in the browser. No service.
- **Files for AI agents**, written by the same build (`src/lib/ai/`), all under the base:
  a Markdown twin of every page (`/methods/password/` is `/methods/password.md`, with front
  matter and absolute links), `llms.txt` (the llmstxt.org index, one line per page),
  `llms-full.txt` (the hand-written pages in one file, under a cap; the generated SDK reference
  is left out), `skill.md` (an agent skill for adding Tula Auth, from
  [`content/skill.md`](content/skill.md)), `sitemap.xml` and `robots.txt`, and a
  `<link rel="alternate" type="text/markdown">` in each page's head. `generate:check` fails for a
  page without a twin, a link in a twin, `llms.txt` or `skill.md` that goes nowhere, and a file
  over its cap. Crawlers read `robots.txt` only at a host's root, so under GitHub Pages' sub-path
  it is there for whoever asks for it by name.
- **A light and a dark theme**, following the system until the reader chooses one.

A Markdown file that cannot be rendered, a relative link to a file that does not exist and an
anchor the target does not have all **fail the build**. A link to a repository file that is not
a page (an ADR, a package README, a source file) becomes its address on GitHub.

The rules for working on it are in [`.claude/rules/docs-site.md`](../../.claude/rules/docs-site.md).

## Where it is published

GitHub Pages serves the site at https://tula-solutions.github.io/tula-auth-and-user-management/,
in two versions that a release and a merge to `develop` keep up to date by themselves:

| Address | What it shows | Built from |
| --- | --- | --- |
| https://tula-solutions.github.io/tula-auth-and-user-management/ | The docs of the **latest release**, marked `v0.1.1` (its version) in the header. Indexed by search engines. | The tip of `main`: the release's own commit. |
| https://tula-solutions.github.io/tula-auth-and-user-management/next/ | The **unreleased** docs, with a banner that says so and links to the released docs. `noindex`. | The tip of `develop`. |

The header's marker switches between the two, to the same page. Nothing is done by hand: a release
is a push to `main` (the release PR's merge; the repository makes no tag and no GitHub Release,
and `release.yml` runs for the same event), and a merge to `develop` is a push to `develop`.
[`.github/workflows/docs-pages.yml`](../../.github/workflows/docs-pages.yml) runs for both (and by
hand from either branch), **builds both versions every time** from the tips of `main` and `develop`
into the one artifact Pages holds, and deploys it: a `build` job that can only read the
repository, then a `deploy` job that holds `pages: write` and `id-token: write` and runs nothing
but `actions/deploy-pages`. A run for `develop` therefore never removes the released docs, and a
run for a release never removes `/next/`; a deployment in flight is never cancelled.

Until a release carries `apps/docs` (the site is on `develop` first, and reaches `main` with the
next release), the root is built from `develop` as well, with the marker and banner saying
**unreleased** and no switch; `/next/` is built too, so that its address exists from the start. The
first release merge that brings `apps/docs` to `main` turns the root into the released docs, with no
change to the workflow. The docs of a release are built by that release's own copy of the site
(its `apps/docs`, from its own lockfile), so an old release keeps the look it had.

Pages must be set to deploy from GitHub Actions, and the `github-pages` environment must allow
**`main` and `develop`** to deploy (a repository setting, made by a person).

The build reads which docs it is from three variables, each checked by `src/lib/release.ts` the
way `DOCS_BASE` is checked by `paths.ts`, and refused for a value it does not know:
`DOCS_CHANNEL` (`release`, `next` or `unreleased`; unset, the site has one version and no marker,
banner or canonical address), `DOCS_VERSION` (a plain `0.1.2`; required for `release`) and
`DOCS_ORIGIN` (`https://host`, for the canonical addresses). The `next` channel must be built
under a base that ends with `/next/`. The released docs write a canonical address to themselves;
the unreleased docs write `noindex` instead, and every address on a `/next/` page stays under
`/next/` except the marker's and the banner's link, which `checkPage` allows to lead to the other
version and nowhere else.

Pages serves a project's site under the repository's name, so the workflow builds with
`DOCS_BASE=/tula-auth-and-user-management/`. Every address the build writes (links, the script
and stylesheet, images, the search index, the 404 page) starts with the base, and the build
stops for a page that holds an address from the host's root outside it. `DOCS_BASE` must start
and end with `/` and hold only letters, digits, `-`, `_`, `.` and `~`, in segments that do not
start with a dot; anything else stops the build before a file is written. Unset, the site is
built for `/`, and `generate:check` renders it under a placeholder sub-path so that an address
that ignores the base fails `verify`. To look at the published build on this machine:

```bash
DOCS_BASE=/tula-auth-and-user-management/ bun run docs-site:dev
# http://127.0.0.1:4321/tula-auth-and-user-management/
```

CI's `e2e-docs` job runs the browser tests against the site built and served under that base, with both versions (`build:versions` builds the root as the release and `next/` as the development docs, from this checkout).

## Test-only variables

`DOCS_OUT_DIR` (where the build writes, and empties) and `DOCS_REPO_ROOT` (the repository it
reads) exist for the build script's own test, which builds a throwaway repository. Both must be
absolute and strictly inside the system's temporary directory (`DOCS_REPO_ROOT` may also be
this repository's own root); `src/lib/paths.ts` refuses anything else before a file is written
or deleted. Do not set them in a shell or a script.
