# `@tula-tech/docs`

The documentation site: the Markdown of [`docs/`](../../docs/README.md) rendered to static HTML.
Private and never published; **nothing serves or deploys it** (it is not in the API image, and
the API does not serve it).

```bash
bun run docs-site:dev      # build, then serve on http://127.0.0.1:4321/ (DOCS_PORT changes the port)
bun run docs-site:build    # build into apps/docs/dist
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
- **A light and a dark theme**, following the system until the reader chooses one.

A Markdown file that cannot be rendered, a relative link to a file that does not exist and an
anchor the target does not have all **fail the build**. A link to a repository file that is not
a page (an ADR, a package README, a source file) becomes its address on GitHub.

The rules for working on it are in [`.claude/rules/docs-site.md`](../../.claude/rules/docs-site.md).

## Test-only variables

`DOCS_OUT_DIR` (where the build writes, and empties) and `DOCS_REPO_ROOT` (the repository it
reads) exist for the build script's own test, which builds a throwaway repository. Both must be
absolute and strictly inside the system's temporary directory (`DOCS_REPO_ROOT` may also be
this repository's own root); `src/lib/paths.ts` refuses anything else before a file is written
or deleted. Do not set them in a shell or a script.
