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
- **Private, never published to npm, never served by the API, never in an image.** The API
  does not host it. The API image's Dockerfile copies nothing of it and `.dockerignore` leaves
  it out (`.claude/hooks/compose.test.ts` holds both): never add it to an image stage.
- **GitHub Pages publishes it, in two versions, under `/tula-auth-and-user-management/`**
  (`.github/workflows/docs-pages.yml`, held by `.claude/hooks/docs-pages.test.ts`): the docs of
  the latest release at the root (built from the tip of `main`, by that tree's own copy of the
  site) and `develop`'s under `/next/` (a banner says they are unreleased, `noindex`). A release
  is a push to `main` (no tag and no GitHub Release is made; `release.yml` starts on the same
  event), `develop` pushes refresh `/next/`, and both versions are built on every run from the
  tips of both branches, because Pages holds one artifact: never make a run build only one. While
  `main` has no `apps/docs` the root is built from `develop` as channel `unreleased`; keep that
  fallback and its test. A `build` job with `contents: read` only, then a `deploy` job with
  `pages: write` and `id-token: write` that runs nothing but `actions/deploy-pages`. Never give
  the build job a permission to write or the deploy job a step of the repository's code; never
  cancel a deployment in flight (`cancel-in-progress: false`). The `github-pages` environment
  must allow `main` and `develop`. What a build is comes from `DOCS_CHANNEL` (`release`, `next`,
  `unreleased`), `DOCS_VERSION` and `DOCS_ORIGIN`, read only through `resolveRelease()` in
  `src/lib/release.ts` (the same style as `resolveBase()`: refused, not tidied; `release.test.ts`
  holds the table); the marker, the banner, `noindex` and the canonical address come from it
  (`layout.tsx`, which this rule does not otherwise describe). The base comes from `DOCS_BASE`,
  read only through `resolveBase()` in `src/lib/paths.ts` (`config.ts`, `vite.config.ts`,
  `serve.ts`, the Playwright config): `/` or a path that starts and ends with `/` and holds only
  unreserved characters, refused otherwise; the `next` channel's must end with `/next/`. Every
  address the site writes is built from the base; an address from the host's root outside it (or
  `//host`) fails the build in `checkPage`, and `build --check` renders under a placeholder
  sub-path when no base is set so that `verify` sees one. The one exception is a link marked
  `data-docs-version` (the header's marker, the banner), which `checkPage` requires to lead into
  the other version's base (`siblingBase`) and nowhere else: a new link to the other version
  carries that attribute, and any other link from `/next/` into the released docs fails the
  build. A link written as `/x` in a component is a 404 on Pages: build it from `base`.
  CI's `e2e-docs` job builds and serves both versions under the Pages base (`build:versions`:
  the root as the release, `next/` as the development docs; `e2e/tests/docs/versions.spec.ts`).
- **Prerendered by our own script, not by a router's prerender.** The pages are documents: each
  is a React 19 component tree rendered with `react-dom/server` to a complete `index.html`
  (`src/lib/site.tsx`, started by `scripts/build.ts`), and the browser gets one small script
  (`src/client/main.ts`: theme toggle, the sidebar drawer, the search) and one stylesheet,
  built by Vite and Tailwind v4 like the dashboard's. TanStack Router is not used: a router
  would hydrate every page, which means shipping the content of all of `docs/` (several MB of
  generated reference) to the browser as JavaScript or fetching each page twice, for links
  that are already plain `<a href>`. The page works with no script. Do not add a client
  framework or hydration without a measured reason.
- **The build fails, and writes nothing, for a file it cannot render or a link it cannot
  resolve** (`bun run --filter @tula-tech/docs generate:check` runs it without writing; it is
  part of `verify`). That is a Markdown file with no `#` heading (the title), a code block in
  a language that is not in `CODE_LANGUAGES` (`markdown` and `md` are, to show a component's
  source), a malformed component (below), a relative link or image to a file that does not
  exist, and a `#anchor` the target does not have. The resolver (`src/lib/links.ts`) is a pure
  function over an injected `LinkEnvironment` and is tested on its own. A link to a repository
  file that is not a page (an ADR, a package README, a source file) becomes its address on
  GitHub (`REPO_URL`, branch `develop`); its anchors are still checked when it is Markdown.
- **Anchors are GitHub's** (`github-slugger`, `-1` for a repeat), because the docs link to
  `file.md#heading` as GitHub renders it. `docs/**` links keep working in both places.
- **The Markdown pipeline is unified**: `remark-parse`, `remark-gfm`, `remark-rehype`,
  `rehype-raw` (the docs hold some raw HTML) and `rehype-stringify`, with the content components
  (below) turned into elements between the parse and `remark-rehype`. Code is highlighted at build
  time by shiki, both themes written as CSS variables, so no highlighter reaches the
  browser. The docs and their rendering are repository content, so a page body goes through
  `dangerouslySetInnerHTML`; **nothing a visitor or an API typed ever does** (the error
  codes' text is escaped, the search results are written with `textContent`).
- **The content components are Markdown first** (`docs/writing-docs.md` documents each with its
  source and its result, and is the page the browser tests drive: **a new component or option
  is added there in the same change**). The same file is read on GitHub, rendered here and
  served as a twin, so a component has to read well as plain Markdown. `src/lib/blocks.ts`
  turns them into elements before `remark-rehype`, as plain mdast nodes with `data.hName` (no
  `remark-directive`: its `:name` text directives would read ordinary prose such as `a :b` as a
  directive). The syntaxes, which are the whole contract:
  - **Callouts**: GitHub's alerts, `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
    `[!CAUTION]`, the text on the lines after the marker (text on the marker's line is refused:
    GitHub would not draw an alert). A plain `>` block quote stays a quiet note.
  - **Containers**: `:::name` and a bare `:::`, each on its own line with a blank line either side
    (a fence sharing a paragraph with text is refused: GitHub would run them together), and
    `{sync="key"}` where the block takes it. `:::steps` (the `###` headings are the steps: all of
    one depth, real headings with anchors, in the outline), `:::tabs` (the headings are the tab
    labels, which are not headings of the page), `:::code-group` (fenced blocks only, named by
    `title="…"` or else the language; the title moves to the tab), `:::params` (one table: `Name`,
    `Type`, `Required` (`yes`/`no`), `Default`, `Description`, drawn as a list of terms and
    definitions). They nest. An unknown or unclosed container, a stray `:::`, a malformed
    attribute, a heading of another depth, a duplicate tab label and an unknown callout fail
    `generate:check` with `file: line N: …` (`BlockError`, wrapped as `RenderError` by
    `analyze`). A new container is added to `CONTAINERS` and `build()` in `blocks.ts`, gets a
    row in `docs/writing-docs.md`'s table of what the build refuses, and an edit in `twinEdits`
    if its Markdown needs one in the twin.
  - **Code fences**: `ts title="app/layout.tsx" {1,3-5}` (`code-meta.ts`; anything else after the
    language is refused, so a misspelt `titel=` is not dropped), `// [!code ++]`, `--` and
    `highlight` (shiki's notation transformers: the comment is removed from the code), and the
    `diff` language. A highlighted or changed line is told by a bar and a `+`/`-` as well as a
    tint, never colour alone. Every block is `div.code-block` > optional title bar >
    `div.code-frame` > `pre`, a copy button and a polite live region. A line never wraps: the
    block scrolls, and `pre` is a tab stop. ` ```tree ` is a file tree (`file-tree.ts`: one entry
    a line, two or four spaces a level, a trailing `/` a folder, ` # note`), a focusable named
    region; on GitHub it is a plain code block.
  - **The Markdown twin** drops the `:::` lines, labels each block of a code group with its tab
    in bold, and keeps headings, tables, callouts and fences as written (`twinEdits`).
- **Tabs work with no script, and are tabs before they are painted.** The server writes every
  panel under its label (what a reader without script sees, in order). Straight after each group
  an inline `<script>` enhances it: the first group of a page carries the whole runtime
  (`src/client/tabs.ts`, written into the page with `Function.prototype.toString` by
  `src/lib/tabs-runtime.ts`, so the function must use nothing outside its body), the others
  call it. It must run inline, never from the deferred bundle, or the stacked panels would be
  painted first; `main.ts` has nothing to do with tabs. The pattern is ARIA tabs with automatic
  activation (Left and Right wrap, Home, End; one tab in the tab order; a panel with nothing to
  focus is a stop of its own). A group with `sync` shares its choice with every group of that
  key on the page, across pages and across browser tabs (`localStorage` key `tula-docs-tabs`, a
  `{key: label}` object, **every read and write in `try`**: blocked or garbled storage means
  the choice lasts for the page, never an error, and a saved label the group lacks falls back to
  its first tab). Its own class is `docs-tabs`: `.tabs` is the header's.
- **The copy button is drawn only where the head's script set `data-js`** (a button that does
  nothing without script is never shown), so it is in the markup and not behind a `hidden`
  attribute a late script would have to clear. `main.ts` copies the lines of the block less those
  a change removes (`.line.remove`), falls back to a selection where the clipboard API is not
  available, and announces "Copied" (or "Copy failed") in the block's `role="status"` region.
- **Icons are CSS masks** (`--icon: url("data:image/svg+xml,…")` on the callout title, the tree's
  entries and the copy button), so they take the colour of the text, need no markup, are not in
  the twin and cannot be read by a screen reader as anything. The meaning is always in a word.
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
  from the reader's saved choice or else the system; the toggle saves a choice (`localStorage`,
  `tula-docs-theme`); CSS falls back to `prefers-color-scheme` where there is no script.
- **The design tokens are the site's own, in `src/lib/design-tokens.ts`**: the colours of both
  schemes, the type scale, radii, shadows, motion and the shell's widths, from
  `docs/plans/docs-overhaul.md` section (e). `tokensCss()` (`src/lib/tokens.ts`) writes them to
  `src/styles/tokens.gen.css` (generated, ignored, never edited) as custom properties, and
  `styles.css` reads them by name: **no colour is a literal in the stylesheet** (a changed line's tints are the `addBg` and
  `removeBg` roles; a highlighted line is `accentSoft`; the code themes' colours are measured
  on all of them)
  (`contrast.test.ts` fails for one). The site does not read `@tula-tech/contract/theme`: the
  sign-in components' default theme is a product-wide decision made in the contract, which is
  meant to adopt the same values; never edit the contract from here. `COLOR_PAIRS` lists every
  text-on-background and control-edge pair the stylesheet draws (4.5:1 for text, 3:1 for an edge
  or a focus ring) and the test measures each in both schemes, with every colour of the code
  themes on the code background (`CODE_COLOR_REPLACEMENTS` in `markdown.ts` changes the one that
  fails): a new pair of colours in `styles.css` is added to `COLOR_PAIRS` in the same change.
  Dark is ink surfaces with paper text, never blue-grey.
- **Fonts are Geist and Geist Mono, self-hosted** (`src/assets/fonts/`, latin variable woff2,
  SIL OFL in `OFL.txt`; about 52 KB together, and the budget is 60 KB). `font-display: swap`,
  a fallback face sized to Geist's metrics, and only the text face is preloaded
  (`PRELOADED_FONT` in `scripts/build.ts`, read from Vite's manifest). Add no other font, weight
  or italic without staying under the budget, and no font from a CDN.
- **The logo is drawn in `src/components/logo.tsx`, from the brand kit's mark** (a balance scale,
  a solid pan and an open one). Every stroke is `currentColor`; the words are Geist outlined to
  paths, so no font loads to draw it. The kit's rules hold: clear space of a pan's height (the
  link's padding), the lockup no narrower than about 120 px (below 480 px of screen the mark
  stands alone). The favicon set, the manifest and `og.png` are in `public/`, copied from the
  kit; `og.png` is made by `scripts/og.ts` by hand and committed. The repository never refers
  to a path outside itself for them.
- **The shell is a header, then at most 1480 px of sidebar, prose and table of contents.**
  The prose is 720 px and never fluid; body text is 16/28; the table of contents is a column
  from 1280 px and a disclosure below it; the sidebar is a column from 1024 px and a drawer
  below it (focus trapped, `inert` page behind, scroll locked; Escape, the scrim, a followed
  link or a wider window close it). Nothing stretches on an ultrawide. The header's tabs come
  from `src/lib/sections.ts` (`SECTION_RULES`: which `docs/README.md` groups or pages a tab
  shows; a tab with no page is not drawn); the sidebar shows the current tab's groups.
  **Slots**: `data-slot="banner"` is a row above the header (not inside it: it scrolls away, so
  the sticky bar keeps the height `--header-h` names; the version notice is drawn in it),
  the header has `data-slot="version"` (beside the logo; the version marker is drawn in it), and
  each page has `data-slot="page-actions"` in its bar. Other changes fill a slot; they do not
  restructure the header or the bar. Inline code is a bordered chip, and
  prose breaks a word only as a last resort (`overflow-wrap: break-word`; `anywhere` is for
  table cells alone): `styles.test.ts` holds both.
- **Accessibility is tested on every page.** The `docs` Playwright project
  (`e2e/tests/docs/site.spec.ts`) opens each page the build wrote (`pages.json`), runs axe
  in light and dark through `expectAccessible` (no rule is disabled) and fails for a page that
  scrolls sideways at 375 px, a console error or a failed request. A wide table or code block scrolls inside its
  own box (`.table-wrap` is a named, focusable region; `pre` is focusable), a heading never
  skips a level in the output and a table header with no text is dropped or given a hidden name
  (`markdown.ts`): fix a failing page in the renderer, never by disabling a rule or by
  editing the Markdown to suit the site. The project runs on its own, with no API behind it:
  `--project=docs` (or `E2E_DOCS_ONLY=1`) starts only the docs server, on port 4321.
- **Every page has a Markdown twin, and the build writes the files an AI agent reads**
  (`src/lib/ai/`, built by `buildSite` for a build of every page and written by `writeSite`;
  none of it for a sample). `<route>.md` for every route (`/methods/password/` is
  `/methods/password.md`, `/docs/` is `/docs.md`, `/` is `/index.md`: `twinPath`): the source
  Markdown with front matter (title, description, url, source, section, `updated` where git can
  say it), a pointer to `llms.txt`, relative links rewritten to the absolute `.md` address of
  the page they name (a repository file to its address on GitHub, an image to its copy under
  `files/`) and the HTML-only parts dropped. The links are rewritten in the source text by
  position (`twin.ts`), never by re-printing the tree, so the Markdown stays the author's.
  Beside them: `llms.txt` (llmstxt.org: a title, a summary, a section per sidebar group, one
  `- [Title](url.md): first sentence` line per page, an `Optional` section), `llms-full.txt`
  (every hand-written page, the generated `reference/**` left out, under `LLMS_FULL_CAP`),
  `skill.md`, `sitemap.xml`, `robots.txt`, and a
  `<link rel="alternate" type="text/markdown">` in each page's head (`withAlternate`; Pages
  cannot send a `Link:` header). **Every address in them is built from `resolveBase()`'s base
  and `SITE_ORIGIN` (`src/lib/ai/urls.ts`)**, never written out, and a published file names the
  origin because an agent reads it away from the site.
- **`checkAiFiles` (`src/lib/ai/check.ts`) is part of `generate:check`**: it fails for a page
  with no twin, a page `llms.txt` leaves out, a link to this site in a twin, `llms.txt` or
  `skill.md` that finds no file or an anchor its page does not have, `llms.txt` over
  `LLMS_TXT_CAP` and `llms-full.txt` over `LLMS_FULL_CAP`. A cap is raised only by measuring
  what an agent can load, never to make a build pass.
- **`skill.md` is written from `apps/docs/content/skill.md`**, the one hand-written file of the
  site that is not in `docs/`. It holds no address: `{{page:docs/quickstart.md#anchor}}` and
  `{{file:llms.txt}}` are resolved by `buildSkill`, and a placeholder that names no page stops
  the build. It says only what the documentation says: a step or a claim is added there in the
  same change as the page that supports it, and what the docs say was not run is said not run.
  Without the file in the repository (a throwaway one) no skill is written.
- **No file of the site starts with a dot.** `actions/upload-pages-artifact` leaves hidden
  files out, so a `/.well-known/skills/index.json` would never be served; discovery is
  `llms.txt` and `skill.md` at the root. `updated` and `lastmod` come from the repository's
  history and only in a clone that has it (`src/lib/ai/git.ts`): the Pages workflow checks out
  one commit, where every file would get that commit's date, so there they are left out.
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
