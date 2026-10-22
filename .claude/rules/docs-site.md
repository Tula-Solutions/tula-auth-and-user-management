---
paths:
  - "apps/docs/**"
  - "e2e/tests/docs/**"
---

# Documentation site

`AGENTS.md` lists this file under "Area rules" and does not repeat it. The app is
[`apps/docs`](../../apps/docs/README.md), `@tula-tech/docs`: the Markdown of `docs/` rendered to
static HTML. Its commands are in its README.

## Documentation site (`apps/docs`)

- **`docs/**/*.md` is the only source, and the site holds no copy of it.** Every Markdown file
  of `docs/` has a page except `docs/plans/`, `docs/adr/` and `docs/codebase-map/`
  (`EXCLUDED_DIRECTORIES` in `src/lib/config.ts`: a decision to leave a directory out is made
  there and in nowhere else). A page's route follows its path (`docs/methods/password.md` is
  `/methods/password/`, a `README.md` is its directory's index, `docs/README.md` is `/docs/`;
  `/` is the landing page). `pages.test.ts` compares the file list to the pages built. A new
  page of `docs/` needs a link in `docs/README.md` to be in the sidebar; one the README never
  mentions still gets a page and lands in the last sidebar group, "More".
- **Private, never published, never served by the API, never in an image.** The API does not
  host it and nothing deploys it. The API image's Dockerfile copies nothing of it and
  `.dockerignore` leaves it out (`.claude/hooks/compose.test.ts` holds both): never add it to
  an image stage. Hosting it somewhere is a decision of its own, with `DOCS_BASE` for a sub-path.
- **Prerendered by our own script, not by a router's prerender.** The pages are documents: each
  is a React 19 component tree rendered with `react-dom/server` to a complete `index.html`
  (`src/lib/site.tsx`, started by `scripts/build.ts`), and the browser gets one small script
  (`src/client/main.ts`: theme toggle, the sidebar button, the search) and one stylesheet,
  built by Vite and Tailwind v4 like the dashboard's. TanStack Router is not used: a router
  would hydrate every page, which means shipping the content of all of `docs/` (several MB of
  generated reference) to the browser as JavaScript or fetching each page twice, for links
  that are already plain `<a href>`. The page works with no script. Do not add a client
  framework or hydration without a measured reason.
- **The build fails, and writes nothing, for a file it cannot render or a link it cannot
  resolve** (`bun run --filter @tula-tech/docs generate:check` runs it without writing; it is
  part of `verify`). That is a Markdown file with no `#` heading (the title), a code block in
  a language that is not in `CODE_LANGUAGES`, a relative link or image to a file that does not
  exist, and a `#anchor` the target does not have. The resolver (`src/lib/links.ts`) is a pure
  function over an injected `LinkEnvironment` and is tested on its own. A link to a repository
  file that is not a page (an ADR, a package README, a source file) becomes its address on
  GitHub (`REPO_URL`, branch `develop`); its anchors are still checked when it is Markdown.
- **Anchors are GitHub's** (`github-slugger`, `-1` for a repeat), because the docs link to
  `file.md#heading` as GitHub renders it. `docs/**` links keep working in both places.
- **The Markdown pipeline is unified**: `remark-parse`, `remark-gfm`, `remark-rehype`,
  `rehype-raw` (the docs hold some raw HTML) and `rehype-stringify`. Code is highlighted at build
  time by shiki, both themes written as CSS variables, so no highlighter reaches the
  browser. The docs and their rendering are repository content, so a page body goes through
  `dangerouslySetInnerHTML`; **nothing a visitor or an API typed ever does** (the error
  codes' text is escaped, the search results are written with `textContent`).
- **Snippet blocks are ordinary code blocks.** `<!-- snippet: … -->` markers are comments and
  are dropped; the block between them is a fenced block the docs generator wrote.
- **The sidebar comes from `docs/README.md`**: each `##` section is a group; in a table the
  first link of a row is an item and its other links are its children; in a sentence each link is
  an item, labelled with the page's title.
- **Search is a static index and a small matcher** (`src/lib/search.ts`): `search-index.json`
  is written at build time, one entry per `##`/`###` section, and the same `search` function
  runs in the browser and in the tests. No service, no library. Every error code is an entry
  and a typed code finds it first (`site.test.ts` holds that for each code).
- **Every error code of the contract has a stable anchor.** `/reference/error-codes/` is
  generated from `@tula-tech/contract/error-codes` (`src/lib/error-codes.ts`): each code is
  the `id` of its own heading (`#password.too_short`), and `error-codes.test.ts` holds that
  every code is on the page. Codes are append-only, so an address never moves. An area's
  heading id is prefixed (`area-password`) so that it can never equal a code.
- **The theme is `data-theme` on the root.** A script in the head sets it before the first paint
  from the reader's saved choice or else the system; the toggle saves a choice; CSS falls back to
  `prefers-color-scheme` where there is no script. The palette is `@tula-tech/contract/theme`,
  written at build time to `src/styles/tokens.gen.css` (generated, ignored by git, never
  edited): no colour is a literal in the site's CSS.
- **Accessibility is tested on every page.** The `docs` Playwright project
  (`e2e/tests/docs/site.spec.ts`) opens each page the build wrote (`pages.json`), runs axe
  in light and dark through `expectAccessible` (no rule is disabled) and fails for a page that
  scrolls sideways at 375 px, a console error or a failed request. A wide table or code block scrolls inside its
  own box (`.table-wrap` is a named, focusable region; `pre` is focusable), a heading never
  skips a level in the output and a table header with no text is dropped or given a hidden name
  (`markdown.ts`): fix a failing page in the renderer, never by disabling a rule or by
  editing the Markdown to suit the site. The project runs on its own, with no API behind it:
  `--project=docs` (or `E2E_DOCS_ONLY=1`) starts only the docs server, on port 4321.
- **shadcn primitives** in `src/components/ui/` are written by `bunx shadcn@latest add` and
  not edited (as in the dashboard). They import `cn` from the bare specifier, mapped by
  `tsconfig.json` and `vite.config.ts`. The primitives used are rendered on the server only.
- **Tests.** `bun test` runs on Bun's default timeout, with none raised, so a test does only
  what it can finish in a fraction of it on a loaded runner (CI ran this package's tests three
  to eight times slower than a laptop): `site.test.ts` renders a sample of pages, and whatever
  needs every page is `generate:check`'s job (`build --check`, part of `verify`, untimed):
  rendering every page, resolving every link, and the cache inputs below. A unit test does not
  scan the repository's pages. `buildSite` parses only what it renders and reads the title of
  another page from the lines before its first `##` (`titleOf`), so a sample build does not
  parse the reference pages.
- **Cache inputs.** The coverage threshold is in the app's `bunfig.toml`; the browser script is
  covered by the Playwright project. The app's five cached tasks (`transit`, `build`, `test`,
  `test:coverage`, `generate:check`) name the same inputs in `turbo.json`
  (`.claude/rules/turbo-inputs.md`): `docs/**` and every file outside `docs/` that a page
  links to (the root `*.md` and `LICENSE`, the READMEs of the apps, packages, examples and
  native SDKs, the example config). **A build of every page checks them** (`checkCacheInputs`
  in `src/lib/inputs.ts`, from the files each render read: `RenderedDoc.files`): it fails for
  a target no input of a task matches and for lists that differ, so a link to a new kind of
  file adds its glob to all five lists in the same change, or the site is served from the
  cache when that file changes. `inputs.test.ts` tries the guard on synthetic inputs and
  links, and `scripts/build.test.ts` holds that the script exits non-zero for a link no input
  matches.
- **`DOCS_OUT_DIR` and `DOCS_REPO_ROOT` are test-only** (the build script's own test builds a
  throwaway repository). Vite empties its output directory, so both go through
  `resolveOutDir()` / `resolveRepoRoot()` in `src/lib/paths.ts`, used by `build.ts`,
  `vite.config.ts` and `serve.ts`: unset gives `apps/docs/dist` and the real repository; set,
  a value must be absolute and strictly inside the (real) temporary directory, or, for the
  repository, the real root, and anything else throws before a write or a delete. Never read
  either variable anywhere else, and never document them as settings.
- **A page's content is cut into sections, so that axe can check a huge page in pieces.**
  `wrapSections` (`markdown.ts`; `error-codes.ts` writes the same markup by hand) wraps the
  content in `<div data-docs-section="n">`: number 0 is the title and introduction, then one
  for each `h2` and `h3`. A `div`, never a `section`: nothing is added to the landmarks. The
  build writes the size of each section to `page-stats.json`; the `docs` project checks a page
  above `CHUNK_THRESHOLD` (`e2e/chunks.ts`) as its frame (everything but sections 1 and up)
  plus runs of sections of about `CHUNK_BUDGET`, each its own test per theme, and every page
  has a test that all its article's children are sections. Never raise a timeout or disable a
  rule for a big page: lower `CHUNK_BUDGET`.
  A section that grows past `SECTION_CAP` is closed at the next block and goes on in a new
  one (`wrapSections`); a single block bigger than the browser tests' piece, a long code block,
  is checked as the block without its lines plus ranges of its `.line`s
  (`e2e/chunks.ts`, `page-stats.json` holds the line counts). Because axe sees only the piece it
  is given, `page-check.ts` checks each whole rendered page at build (so in `generate:check`):
  no `h1`, a section over `SECTION_CAP` that is more than one block, a heading level skipped from
  the `h1` on, a duplicate id, a dangling
  `aria-labelledby` / `aria-describedby` / `for`. Never replace it with an axe `runOnly`.
