# Tula Auth docs overhaul: research and design spec

Scope: research and design spec; slice 2 (design system and shell, TULA-98) is built from sections (e), (f) and (g). The benchmark sites were captured at six viewport widths (390, 768, 1280, 1440, 1920, 2560), light and dark; the screenshots and raw metrics are not kept in the repository, and the numbers quoted below are the findings.

**Honesty about coverage.** Full computed-style + 6-viewport captures succeeded for Stripe, Clerk, shadcn, Next.js, Supabase and Tula. They failed (browser closed mid-run in the earlier attempt) for Resend, Tailwind, Claude docs, Vercel, Bun and Better Auth. For those six I have the AI-surface artifacts (llms.txt, `.md` pages, agent playbooks) fetched and verified, but no computed-style or screenshot data; their entries below are limited to that and are marked. Deeplink URL formats in (c) come from my knowledge of those products' schemes and are marked "verify" where I did not fetch them.

---

## (a) Per-site findings

Page weights are transferred bytes on a cold load of one guide page (Chromium, desktop).

### Stripe docs (docs.stripe.com)
- **IA.** Two-tier header: logo + centered Search (`/` shortcut) + "Ask AI" pill; second row of product tabs (Get started, Payments, Revenue, Risk, Data, ...) with APIs & SDKs and Help dropdowns. Left sidebar 280px with section captions in uppercase, collapsible trees with chevrons, a collapse-sidebar button, locale/country switcher pinned at the bottom. Breadcrumb ("Home / Payments") above H1.
- **Integration picker.** The signature pattern: on "Accept a payment" a segmented control (Checkout / Elements / Mobile) swaps the entire page body, then a second-level underline tab (Stripe-hosted page / Full embedded page). An "Integration effort / type / UI customization" comparison card sits right under it. The code samples have a framework switch (Node, Ruby, Python...) that persists.
- **Page anatomy.** H1 32/40 700, a 24px lead sentence, then a row of text actions: "Ask about this page", "Copy for LLM", "View as Markdown", "Set up agent" (with Claude/OpenAI/Cursor glyphs). Right rail "On this page" (uppercase caption, nested, "Optional" tags). Yes/No feedback at the end.
- **Type/spacing (1440).** System stack (`-apple-system, system-ui, Segoe UI, Roboto`), zero webfonts. Body 14px/20px colour `#414552`, headings `#1a1f36`; H2 24/32 weight 400 (!); inline code Menlo 14.4px `#3c4257`; code block 13/19. Content column 798px at 1440, 813px at 1920+ (about 121-123 characters per line: Stripe's measure is the widest of the set and relies on 14px text). Sidebar 280px.
- **Responsive.** 390: sidebar and TOC gone, 24px gutter (content inset to 40 for the content rail). 1280: sidebar 250, content 668. 1920 and 2560: content stays 813px, the whole shell centres; no horizontal scroll at any width.
- **Weight.** 14.1 MB (13.6 MB JS, 25 requests), DOMContentLoaded 1.05 s guide / 2.47 s landing. Client-rendered app. The heaviest of the set; do not emulate.
- **AI.** `/llms.txt` (97 KB) opens with agent *behaviour instructions* ("always check the npm registry for the latest version; never hardcode a version from training data; prefer sandboxes"), then a link index. Every page has a `.md` twin (`/payments/accept-a-payment.md`, `text/markdown`). A dedicated "Agents and AI on Stripe" page lists a hosted MCP server (`mcp.stripe.com`), an agent plugin, agent skills and a skills catalog at `/.well-known/skills/index.json`.

### Clerk docs (clerk.com/docs)  (closest competitor)
- **IA.** Header is minimal: search (⌘K) left of content, one dark "Sign Up" button; logo + "Docs" + version pill ("Core 3") live at the top of the sidebar. The sidebar opens with a **"Select your SDK" dropdown** (Next.js, React, Expo, Astro, Nuxt, iOS, Android ...) that rewrites the sidebar and URLs (`/docs/nextjs/...`); under it two tabs, Guides / Reference; then collapsible groups (Getting started, Authentication flows, User management, Session management, Organizations, Billing, ...). The quickstart sidebar has the SDK picker; the page has an "Available in other SDKs" icon grid in the right rail.
- **Quickstart pattern (the one to copy).** The page leads with an **agent prompt block**: a card titled "Add Clerk to Next.js" with a purple "Copy prompt" button and an "Expand prompt" fade, then "Or set up Clerk yourself by following the step-by-step instructions" as a collapsed disclosure. Page intro says: hand this to your agent; CLI `npx clerk@latest init`; Agent Skills `npx skills add clerk/skills`; or `clerk.com/SKILL.md`.
- **Anatomy.** Breadcrumb ("Guides / Getting started"), H1 32/40 600 with -0.48px tracking, lead 15/28, note callout with icon and left rule, "Next steps" cards, "Edit on GitHub", last updated, floating AI chat button (bottom right).
- **Type (1440).** Fonts: Suisse Intl (body, 9 weights/italics = 212 KB of fonts) + Geist numbers + Soehne Mono. Body 16/24, paragraphs 15/28 `#42434d`, headings `#131316`. H2 20/28 600; H3 14/20 500. Mono 12-13px. Content column is **696px at every viewport from 768 to 2560**; it just re-centres (x=350 at 1440, 590 at 1920, 910 at 2560). Sidebar 282px. About 100 characters per line at 15px.
- **Dark.** bg `#131316`, body `#9394a1`, headings `#fff`.
- **Weight.** 4.0 MB guide, 3.0 MB landing; 105 KB HTML; 1.3 MB JS.
- **AI.** `/llms.txt` (2,726 lines; first line says: "Search these docs: `https://clerk.com/docs/search.md?q=<query>` (optional `&sdk=`). Append `.md` to a docs page URL for markdown"), a searchable **markdown search endpoint**, `/docs/guides/ai/*` section (skills, prompts, MCP, CLI-for-agents), `clerk.com/SKILL.md`.

### shadcn/ui (ui.shadcn.com)
- **IA.** Top bar: Home, Docs, Components, Blocks, Charts, Directory, Typeset, Create; search pill; GitHub star count; theme toggle; black "New" button. Sidebar is a flat alphabetical list under a single caption ("Components"), a faint vertical rule at its right, active row a rounded grey pill, small blue dot for "New". Sidebar fades out at the bottom.
- **Anatomy.** H1 30/36 600 -0.75px; lead 15/26 in muted grey; **"Copy Page" split button with chevron menu + prev/next arrow buttons** beside the H1 (this is the cleanest page-action placement in the set). Right rail "On This Page" 288px, plus a small sponsor card.
- **Components.** The preview/code unit: a framed, rounded (about 14px) box with the live component centred in a dotted/clean canvas, then a code panel collapsed to 3 lines with a gradient fade and a centred **"View Code"** pill. Library tabs (Base UI / React Aria / Radix UI) as underlined text tabs above the preview. Install block: "Command / Manual" tabs, inside it a terminal-icon header with **pnpm / npm / yarn / bun** pills (persisted) and a copy icon, code in 14px/24.5 Geist Mono. Steps use numbered headings in "Manual".
- **Type (1440).** Geist 16px; H2 18.75/26, H3 16.9/24.5, p 15/26.25; inline code 12.75px. Prose column **640px** fixed at every viewport 768 to 2560 (x=400 at 1440, 960 at 2560; about 91 cpl). Sidebar 224-288px, TOC 288px; shell centred.
- **Weight.** 7.2 MB (5.6 MB JS, 1.1 MB fonts including Noto Sans Arabic for RTL).
- **AI.** `/llms.txt` has a one-sentence project summary + curated links with one-line descriptions ("Open Code. Open Source. AI-Ready"); a **Skills** page (`npx skills add shadcn/ui`; the skill runs `shadcn info --json` for project context); an MCP server page; "Open in v0" and **"Open in Cursor"** actions on pages; `shadcn docs/search/view` CLI commands for agents.

### Vercel / Next.js (nextjs.org/docs)
- **IA.** Header with logo, version-aware docs, ⌘K search; sidebar 300px with a "Documentation" label, App Router / Pages Router switch (the same URL space split by router), nested groups; right rail 268px "On this page". Footer prev/next cards, "Edit this page on GitHub", "Give feedback" widget.
- **Page actions.** "**Copy page**" button with a menu including "Copy for LLM"; floating "Ask AI".
- **Type (1440).** Geist 16px/26.4; H1 **40/48 weight 450, -2px tracking**, H2 24/32 450 -0.96, H3 20/26; body 28px line-height at 16px (1.75). bg `#fafafa`, text `#171717`; code surfaces white with 8px radius. Dark: **pure black** bg, text `#ededed`, code `#0a0a0a`. Prose 716px (95 cpl) at 1440; 648 at 1280; 720 at 768; grid is sidebar 300 + prose 780 (the `nd-page` wrapper) + TOC 268, centred: at 1920 the sidebar starts at x=236, at 2560 at x=556 (i.e. fixed 1,350px shell, centred).
- **Weight.** 1.19 MB guide (597 KB JS, 91 KB fonts, 96 requests), DOMContentLoaded 309 ms. The best weight/polish ratio of the big sites.
- **AI.** `/docs/llms.txt` (51 KB) with `@doc-version: 16.4.2` metadata lines and a `@doc-version-notes`, grouped by `##` section links with descriptions; `/docs/llms-full.txt` (4.4 MB) where each page starts with YAML front matter (`title`, `description`, `url`, `docs_index: /docs/llms.txt`, `related:`) and a `> For an index of all documentation, see ...` pointer. Vercel's own `vercel.com/llms.txt` has "When to use Vercel" and "How agents should use Vercel" sections, plus `vercel.com/get-started.md`, a **full agent playbook** ("Perform actions yourself ... Pause only for user authentication"), a plugin, skills, a hosted MCP and an OpenAPI file.

### Supabase docs (supabase.com/docs)
- **IA.** Header: logo + "DOCS" mono label, top nav (Start, Products, Build, Manage, Reference, Resources, each a dropdown), ⌘K search, green "Sign up", menu button. Left sidebar per product with an icon+name header ("Auth"), mono uppercase captions (GETTING STARTED, CONCEPTS, FLOWS (HOW-TOS)), green active link. Framework pages are **separate sibling pages** (Next.js, Astro, React, React Native...) under "Getting started", not a switcher.
- **Anatomy.** Breadcrumb with chevrons, H1 34/38 Manrope 600, lead 18px muted. **Right rail is a utility rail, not a TOC**: "Is this helpful? (x / check)" then "AI TOOLS": *Connect your AI agent, Copy as Markdown, Ask ChatGPT, Ask Claude, Prefer on Google*. "Edit this page on GitHub".
- **Components.** **Numbered vertical step timeline** (circle numbers on a thin rail, 24px offset); code blocks with a file-name tab ("SQL_EDITOR") and line numbers; inline code with border.
- **Type (1440).** Manrope headings + Inter 15px/28 body (weight **500**) + Source Code Pro 13px; bg `oklch(0.995 0 337)`, text `oklch(0.394)`, headings `oklch(0.1)`. Dark: bg `oklch(0.19)`, text `oklch(0.798)`. Prose 557px at 1280, 658 at 1440, 683 at 1920+ (76-93 cpl). Sidebar 316-361px growing with the viewport.
- **Weight.** Guide HTML 27 KB, 122 KB measured transfer in the capture (lazy chunks not all counted; page also logs a React hydration error 418, which we should avoid), DOMContentLoaded 355 ms.
- **AI.** `supabase.com/llms.txt` is a short *directory of per-topic llms files* (Auth, Database, Functions...) with ".md" page links, and a pointer to `llms-full.txt` (7.3 MB). Dedicated **"AI Prompts"** page that gives per-IDE install table (Cursor `.cursor/rules/*.mdc`, Copilot `.github/copilot-instructions.md`, JetBrains `guidelines.md`, Gemini CLI `GEMINI.md`, VS Code `.instructions.md`, Claude Code `CLAUDE.md`); "MCP Authentication" docs.

### Resend docs (resend.com/docs) - fetched AI surfaces only
- Mintlify site. `/docs/llms.txt` opens with a `>` summary then a flat list of `[Title](...md): description`. `/docs/<page>.md` returns `text/markdown` with a two-line header block: `> ## Documentation Index` / `> Fetch the complete documentation index at: .../llms.txt` / `> Use this file to discover all available pages before exploring further.` Some pages embed an *agent-targeted ruleset* ("Purpose: enforce only the current and correct instructions ... Scope: all AI-generated advice must follow these guardrails").
- `/docs/ai-onboarding.md` is the model "AI onboarding" page: states "a human must create the account and API key", then sections MCP Server (hosted `https://mcp.resend.com/mcp`, OAuth, or API key bearer, or `npx resend-mcp`), CLI, Docs for Agents, Skills, Quick-start guides per tool, Integrations. 2.4 MB `llms-full.txt`.

### Tailwind CSS (tailwindcss.com/docs) - limited
- `llms.txt` and `llms-full.txt` URLs both return the HTML 404/app shell rather than text (the saved files are 133 KB of HTML), and `/docs/installation.md` is 404: **Tailwind does not publish a working llms.txt or per-page `.md` as of this capture.** (A useful negative: even a top docs site has no AI surface and it is a gap people complain about.) No computed-style capture succeeded.

### Anthropic Claude docs (platform.claude.com/docs) - fetched AI surfaces only
- Mintlify-class site. `/llms.txt` (89 KB) is *rich*: root URL, **MCP server (`/docs/mcp`, Streamable HTTP) with a server-card URL**, **`/docs/sdk-versions.json`** (latest version of each SDK as JSON), language matrix (808 English pages, 292 for each of 10 locales). `/docs/en/get-started.md` returns `text/markdown` (19 KB). `/llms-full.txt` is **46.9 MB** (too large for any context: shows the limit of the "one file" approach; per-section files are better).
- Mintlify's contextual menu spec (fetched, `llms/mintlify-ctx.md`): options `copy`, `view`, `assistant`, `chatgpt`, `claude`, `perplexity`, `grok`, `aistudio`, `devin`, `mcp` (copy MCP URL), `add-mcp` (copy `npx add-mcp` command), `cursor` / `vscode` (install hosted MCP), `download-spec`. Mintlify serves a `Link:` response header advertising `llms.txt`, `llms-full.txt`, `api-catalog`, `mcp-server-card`, `agent-card`, `agent-skills` index, and hosts `/skill.md` (the agentskills.io spec: capability summary, distinct from llms.txt, which is a directory).
- Mintlify's llms.txt rule: list pages in nav order, links end `.md`, cap an index at 100,000 chars and split into `/_llms/*.txt` sub-indexes beyond that.

### Better Auth and Bun - AI surfaces only
- **Better Auth** `/docs/llms.txt` is a *version router*: "Use the documentation version that matches the Better Auth version installed in the project ... fetch its `.md` URL ... cite the canonical URL without `.md`", links to a docs MCP server (`mcp.better-auth.com/mcp`) and per-version indexes (`/docs/1.6/llms.txt`, `/docs/beta/llms.txt`). Worth copying for versioned docs.
- **Bun** `/docs/llms.txt` (34 KB) flat list of `.md` pages with descriptions, `llms-full.txt` 2.1 MB, the descriptions are rewritten to be *retrieval-oriented* ("Fix 'Cannot find name Bun' ... after upgrading TypeScript").

### Cross-site numbers (1440 desktop)
| Site | Body | Prose width | Sidebar / TOC | Fonts | Weight |
|---|---|---|---|---|---|
| Stripe | 14/20 system | 798 (121 cpl) | 280 / ~200 | none | 14.1 MB |
| Clerk | 15/28 Suisse | 696 (100 cpl) | 282 / ~190 | 212 KB | 4.0 MB |
| shadcn | 15/26 Geist | 640 (91 cpl) | 224-288 / 288 | 1.1 MB | 7.2 MB |
| Next.js | 16/28 Geist | 716 (95 cpl) | 300 / 268 | 91 KB | 1.2 MB |
| Supabase | 15/28 Inter 500 | 658 (89 cpl) | 325 / ~190 | ~2 files | 122 KB* |
| **Tula (today)** | 15/24.75 system | 749 (107 cpl) | 256 / 224 | none | **97 KB** |

Pattern: every modern site fixes the prose between **640 and 720 px** and centres the shell; none lets prose grow with the screen. Ours is the widest measure after Stripe, at a smaller font.

### Cross-site patterns (what almost every one does)
1. Top nav + left sidebar (260-320px) + right "On this page" (230-290px) + prose 640-720px, shell centred at ultrawide.
2. ⌘K search with a modal (Clerk, Next, Supabase, shadcn); Stripe uses `/`.
3. A page-level AI menu: Copy page / View as Markdown / Open in ChatGPT / Claude (Stripe, Next, shadcn, Supabase, Mintlify sites).
4. Per-page `.md` twin and an `llms.txt` (all but Tailwind).
5. Headings with negative tracking (-0.02 to -0.05em) and 450-650 weight, not bold 700.
6. 8px radius code blocks, copy button on hover, tabs for package managers (shadcn, Next, Clerk).
7. A framework-scoped quickstart: Clerk (sidebar SDK select, URL prefix), Supabase (sibling pages), Stripe (segmented page-swapper).
8. Breadcrumb + edit-on-GitHub + feedback + last-updated at the foot (Next, Supabase, Clerk).

**Motion/micro-interactions observed (shadcn, Next, Clerk, Supabase):** only subtle: 100-200ms colour/background transitions on nav items, tab underline slide (shadcn), fade-gradient on collapsed code, chevron rotate on tree expand, button press scale 0.98 (Clerk), copy-button icon swap to a check for about 1.5 s. No scroll-jacking. All respect `prefers-reduced-motion`.

---

## (b) Ranked patterns to adopt

Effort: S = under a day, M = 1-3 days, L = a week. "Static fit" says how it works on our build (a per-page React `renderToStaticMarkup` + one small client script + GitHub Pages).

| # | Pattern | Why | Static fit | Effort |
|---|---|---|---|---|
| 1 | **Per-page `.md` twins + `llms.txt` + `llms-full.txt` + `sitemap.xml` + `robots.txt`** (Stripe, Next, Clerk, Resend, Mintlify) | Table stakes for "AI native"; zero runtime; the source *is* Markdown so we only copy it with links resolved | Write extra files in `build.ts` beside each `index.html`: `/quickstart/index.md` is awkward on Pages (no content negotiation), so emit **`/quickstart.md`** next to `/quickstart/`; GitHub Pages serves `.md` as `text/markdown`? It serves `text/markdown; charset=utf-8` in practice (verify on first deploy) | M |
| 2 | **Page action bar: Copy page (Markdown) / View as Markdown / Open in ChatGPT / Open in Claude** (shadcn split button, Supabase rail, Stripe row) | Highest-visibility AI feature; pure client JS: `fetch('page.md')` and `navigator.clipboard`; deeplinks are plain `<a>` | Server-render the buttons as links (works without JS), add copy via 15 lines of client JS | S |
| 3 | **Framework-picked Get started** (Clerk's SDK select; Supabase's per-framework sibling pages) | Our five SDKs are the product; today the quickstart is a monorepo-contributor flow | Sibling static pages `/start/nextjs/`, `/start/react/`, `/start/expo/`, `/start/swift/`, `/start/kotlin/` + a picker component on `/start/` and in the sidebar; remember last choice in `localStorage` and show it first | M |
| 4 | **"Add Tula with your agent" prompt block at top of every quickstart** (Clerk) | The most distinctive AI-native pattern in the set; converts the docs into an agent task | One server-rendered card with a copy button; prompt text lives in `docs/` as Markdown so it is in `llms.txt` too | S |
| 5 | **Design system: tokens, Geist + Geist Mono self-hosted, logo lockup** (Next/shadcn Geist, Supabase typography) | The site currently looks like generic system UI; this is the "premium" lever | Fontsource variable woff2 (latin subset, `font-display: swap`, preload one) copied to `dist/assets`; about 60 KB | M |
| 6 | **⌘K command palette modal with grouped results** (Clerk, Next, Supabase) | Replaces the inline search box; keyboard first; our index is already client-side | Reuse `search.ts` and `search-index.json`; add a `<dialog>`, grouping by sidebar section and result kinds (Page, Section, Error code, CLI command), recent searches in `localStorage` | M |
| 7 | **Page anatomy: breadcrumb, lead, prev/next cards, edit on GitHub, last updated, feedback** (Next, Supabase, Clerk) | Orientation + trust; all derive from data we have (path, `git log -1`, sidebar order) | Build-time only, except feedback which is a link (below) | M |
| 8 | **Content components: callouts, steps, tabs with persisted choice, package-manager tabs, code-block header (filename, copy, line highlight, diff)** (Supabase steps, shadcn install tabs, Stripe code tabs) | Our docs are long walk-throughs; today they are headings + blockquotes | Markdown extensions in `markdown.ts` (GitHub alerts `> [!NOTE]`, ` ```ts title="x" {2,4} `, `:::steps`, tab groups as `<div role=tablist>`), progressive enhancement: without JS all tab panels print stacked with labels | L |
| 9 | **Responsive shell fixed at 720px prose, centred, with an ultrawide rail** (Clerk 696 at all widths, Next, shadcn) | Fixes our 107 cpl measure and the wasted 60% of a 2560 screen | CSS only | S |
| 10 | **Collapsible, 5-group sidebar with a top tab row (Guides / Components / Self-hosting / CLI & MCP / Reference)** (Stripe tabs, Clerk Guides|Reference) | Our sidebar is 13 groups fully expanded; a long scroll | `nav.ts` already builds groups; add a `section` field and render collapsed `<details>` with the current branch open | M |
| 11 | **Install deeplinks for the Tula MCP server** (Mintlify cursor/vscode/add-mcp; Resend; Vercel) | We already ship `tula mcp`; one-click install is the AI-native signature | `<a href="cursor://...">` and `vscode:mcp/install?...` buttons, plus a copy of `claude mcp add ...` and `npx add-mcp` | S |
| 12 | **`/skill.md`, `/.well-known/skills/index.json`, and AGENTS.md / rules snippets page** (Mintlify, Stripe, shadcn, Clerk, Supabase "AI Prompts") | Gives agents the capability summary; copy-pasteable rules for `.cursor/rules`, `CLAUDE.md`, `AGENTS.md` | Static files; the page is Markdown | S-M |
| 13 | **Preview/code unit for `@tula-tech/react` components** (shadcn) | "Components" is a top-level tab in our IA; show the real component | Build-time screenshot images (light/dark) generated by the existing Playwright `e2e` project, plus a code panel; avoid hydrating live components on a static site | L |
| 14 | **Versioned docs router** (Better Auth llms.txt, Next `@doc-version`) | Future-proofing; costs nothing now | Put `@doc-version` in llms.txt; defer the version selector | S |
| 15 | **Feedback: "Was this helpful?" thumbs** (Supabase, Next) | Closes the loop | Static site cannot store votes: link to a prefilled GitHub issue / discussion (`?title=Docs feedback: <route>`); no third-party analytics | S |
| 16 | **Structured data + OG image per page** | Sharing and SEO | Build-time SVG-to-PNG (reuse the logos kit renderer idea) or one static OG image + per-page `og:title/description` | M |

**Explicitly not adopting:** an "Ask AI" chat box (needs a server and an LLM bill; the static site stays static: offer "Open in Claude/ChatGPT" + MCP + `llms-full` instead), a client router/hydration (already ruled out in `docs-site.md`), a 7-14 MB JS app (Stripe, shadcn), uppercase mono captions everywhere (Supabase; too trendy).

---

## (c) AI-native feature set and exact formats

All are build outputs written to `dist/` (so under the Pages base `/tula-auth-and-user-management/`; every URL below is built from `base`, per `docs-site.md`).

### 1. Per-page Markdown: `<route>.md`
`/methods/password/` -> **`/methods/password.md`**; landing `/` -> `/index.md`. Content: the source Markdown with (1) YAML front matter, (2) a one-line index pointer, (3) relative links rewritten to absolute canonical `.md` URLs, (4) snippet blocks already expanded (they are in the source), (5) no site chrome.

```md
---
title: Password
description: Sign-up, sign-in, reset and the password policy.
url: https://tula-solutions.github.io/tula-auth-and-user-management/methods/password/
source: https://github.com/Tula-Solutions/tula-auth-and-user-management/blob/develop/docs/methods/password.md
section: Sign-in methods
updated: 2026-10-20
docs_index: https://tula-solutions.github.io/tula-auth-and-user-management/llms.txt
---

> For an index of all documentation, see [llms.txt](https://tula-solutions.github.io/tula-auth-and-user-management/llms.txt).

# Password
...
```
(Front matter style from Next.js; pointer line from Resend/Mintlify.) Also add `<link rel="alternate" type="text/markdown" href="/methods/password.md">` in each page `<head>` so crawlers/agents find it. GitHub Pages cannot send a `Link:` header; the `<link>` tag is the substitute.

### 2. `/llms.txt` (llmstxt.org spec: H1, blockquote summary, H2 sections of `- [Title](url): description`)
```md
# Tula Auth

> Open-source, self-hostable authentication and user management: prebuilt UI, native mobile SDKs and data you own. Bun + TypeScript; PostgreSQL; an OpenAPI contract every SDK is generated from.

@doc-version: 0.1.1
@docs-updated: 2026-10-22

## How agents should use these docs
- Fetch the `.md` URL of any page below (append `.md` to its address, drop the trailing slash).
- Install the latest packages: run `bunx create-tula@latest`; never pin a version from memory (`npm view @tula-tech/core version`).
- Prefer error-code anchors (`/reference/error-codes/#password.too_short`) to guessing; codes are append-only.
- Expo, Swift and Kotlin SDKs are not published to a registry: use them from a checkout (see their pages).
- Full text: [llms-full.txt](.../llms-full.txt). Skill: [skill.md](.../skill.md). MCP: `bunx tula mcp`.

## Get started
- [Quickstart](.../quickstart.md): From nothing to a signed-in user ...
- [Next.js](.../start/nextjs.md): ...
## Guides
## Components
## Self-hosting
## CLI & MCP
## SDK reference
## API reference
## Error codes
## Optional
- [Architecture decisions](https://github.com/.../docs/adr): ...
```
Rules: one line per page; description = the page's first sentence (we already compute it for `<meta description>`); order = sidebar order; links end in `.md`; the `## Optional` section marks skippable pages per the spec (ADRs, plans, "not verified"); keep under 100,000 chars (Mintlify's cap), else split to `/llms/<section>.txt`. Opening instruction block copies the *idea* of Stripe's and Vercel's "how agents should use X".

### 3. `/llms-full.txt`
Concatenation of every page's Markdown in sidebar order, each prefixed by its front matter block (Next.js format), separated by a blank line and `---`. **Also emit per-section files** (`/llms/guides.txt`, `/llms/reference.txt`...) because Claude's full file is 46.9 MB and Supabase's 7.3 MB: our generated SDK reference is large, so exclude `docs/reference/**` from `llms-full.txt` (list it in `llms.txt` only) and publish it as `/llms/reference.txt`. Target: `llms-full.txt` under about 1.5 MB.

### 4. `/skill.md` (agentskills.io spec: Mintlify, Clerk `SKILL.md`, shadcn skills)
```md
---
name: tula-auth
description: Add Tula Auth (self-hosted auth, prebuilt UI) to a Next.js, React, Expo, Swift or Kotlin app and run the server locally.
---
# Tula Auth
## When to use / When not to use
## Inputs a human must provide (Docker, a publishable key shown by `tula dev`)
## Steps (detect framework -> `bunx create-tula` -> `bunx tula dev` -> install SDK -> mount provider)
## Verify (`bunx tula doctor`)
## Constraints (never print .env; never commit keys; use `@tula-tech/*` latest)
```
Plus `/.well-known/skills/index.json` (Stripe's form: array of `{name, description, url}`) and an installable `skills/tula-auth/SKILL.md` in the repo so `npx skills add Tula-Solutions/tula-auth-and-user-management` works.

### 5. Agent quickstart prompt (Clerk pattern), per framework page
A copyable fenced block, e.g. for Next.js: "Add Tula Auth to this Next.js App Router project. First inspect for existing auth, never read `.env*`. Run `bunx create-tula@latest --framework nextjs --into .` ... Fetch https://.../start/nextjs.md for the exact steps. Verify with `bunx tula doctor` and report anything you could not do." Stored in the Markdown source so it appears in `.md` and `llms-full`.

### 6. Page actions menu
Server-rendered `<a>` links so they work without JS:
- **Copy page** (JS: `fetch(.md)` then clipboard; fallback link "View as Markdown").
- **Open in ChatGPT**: `https://chatgpt.com/?hints=search&q=` + encoded "Read <page .md URL> so I can ask questions about it." (verify param name: ChatGPT has used `q`/`prompt`).
- **Open in Claude**: `https://claude.ai/new?q=` + the same text (verify).
- **Open in Cursor / VS Code (MCP)**: `cursor://anysphere.cursor-deeplink/mcp/install?name=tula&config=<base64 {"command":"bunx","args":["tula","mcp"]}>` and `vscode:mcp/install?<urlencoded {"name":"tula","command":"bunx","args":["tula","mcp"]}>` (verify; both are documented by those IDEs). Note `tula mcp` is a local stdio server needing `TULA_API_URL` and `TULA_SECRET_KEY`, so the deeplink also carries `env` placeholders.
- **Copy MCP command**: `claude mcp add tula -- bunx tula mcp`.

### 7. "Docs MCP" without a server
Resend, Better Auth, Stripe and Vercel host docs MCP servers; we cannot (static Pages). Instead add a **`docs_search` / `docs_read` tool to `@tula-tech/mcp`** that reads a bundled `search-index.json` + the `.md` files shipped inside the package, offline and version-matched to the installed SDK. That is a genuine differentiator (docs always match the installed version) and uses code we already have (`search.ts`).

### 8. Rules-file guidance page ("Build with AI", Supabase "AI Prompts" model)
A page containing a table of where to paste our rules per tool (Claude Code `CLAUDE.md`/`AGENTS.md`, Cursor `.cursor/rules/*.mdc`, Copilot `.github/copilot-instructions.md`, JetBrains `guidelines.md`, Gemini `GEMINI.md`, VS Code `.instructions.md`) and **one canonical `tula-rules.md`** (10-20 lines: use `@tula-tech/*` latest, publishable key client-side only, secret key server-side only, never persist the refresh token outside the SDK's store, branch on error `code` not `detail`, always handle `needs_*` steps). `create-tula` writes it into new projects (`AGENTS.md`). Submit the repo to **Context7** (add `context7.json` with `projectTitle`, `description`, `folders: ["docs"]`, `excludeFolders: ["docs/adr","docs/plans","docs/codebase-map"]`, `rules: [...]`); docs are plain Markdown so it ingests directly.

### 9. Discovery plumbing
`robots.txt` (allow all, `Sitemap:` line), `sitemap.xml` (every route, `lastmod` from git), `<link rel="alternate" type="text/markdown">`, and `<meta name="llms" ...>` is not standard: skip it. Add a visible "For AI agents" footer link row (`llms.txt`, `llms-full.txt`, `skill.md`, MCP).

---

## (d) Proposed information architecture

**Header (desktop):** logo lockup | tabs: **Get started** · **Guides** · **Components** · **Self-hosting** · **CLI & MCP** · **Reference** | ⌘K search (pill, "Search docs ⌘K") | GitHub (stars) | theme toggle | "Open dashboard" is not a docs concern: omit.
**Mobile header:** menu button, logo mark, search icon, theme.
**Sidebar** changes with the active tab (Clerk/Stripe model), collapsed groups with the current branch open.

```
GET STARTED  (/start/)                          <- framework picker page + sidebar select
  Overview: what Tula is, the balance in 60 seconds
  Pick your stack:  Next.js | React (Vite) | Expo | Swift (SwiftUI) | Kotlin (Compose)
     each: Prerequisites -> Run the server -> Install -> Add sign-in -> Protect a route/screen -> Verify -> Next steps
  Build with AI  (agent prompt, llms.txt, skill, MCP, rules files, Context7)
  Concepts: flows and steps, sessions and tokens, environments and keys

GUIDES
  Sign-in methods: Password, Emailed code, Emailed link, Texted code, OAuth (+ 8 providers), Passkeys, Two-step verification
  Sessions & security: Sessions, Device binding, JWT templates
  Users & messaging: Phone numbers, Email templates
  Your backend: Webhooks, Hooks, Verify tokens (nextjs/admin)
  Native: Expo, Swift, Kotlin, Native apps (registration, association files)

COMPONENTS (visual, with previews)
  <SignIn/>, <SignUp/>, <ResetPassword/>, <Account/>, Theming (tokens table), Localisation/strings, Slots/customisation, SwiftUI TulaAuthView, Compose TulaAuth

SELF-HOSTING
  Overview, Docker Compose, Settings (env vars), Postgres & Redis, Several instances & proxies, Webhook worker, Upgrades & backups, Security checklist, Releasing

CLI & MCP
  create-tula, tula dev / doctor / diff / apply / policy test / approve, tula.config.ts (config), MCP server, Agent keys & proposals

REFERENCE
  SDK reference: core, react, nextjs, expo, expo-screens, admin, config, contract
  Swift reference, Kotlin reference
  API reference (OpenAPI rendering: see note)
  Error codes (anchored)
  Changelog / What was not verified (moved here from "Start here")
```
Notes: (1) "What was not verified" currently sits in Start here: it is honest but frightening for a first visit; move to Reference > Status and keep a short "Status: early 0.x" banner on Get started. (2) **API reference** is not in the current site: render `packages/contract/openapi.json` at build into per-tag pages with parameter tables, request/response examples and error codes (this is where Stripe/Clerk's API tables apply); S/M slice 6. (3) Clerk puts the framework in the URL (`/docs/nextjs/...`); we use `/start/<framework>/` only for the quickstarts, so guide URLs stay stable.

---

## (e) Design tokens and contrast

### Direction
"Ink and paper, in balance." Warm neutrals straight from the kit (`#1A1A18` ink, `#F1EFE8` paper, `#5F5E5A` grey), one restrained chroma (the existing product violet, retuned for AA on paper) used only for interaction (links, focus, current nav, selected tab), and a second two-tone motif from the mark: **solid vs open** (filled vs outlined buttons, filled vs hollow bullets in steps; "AI" = solid, "human" = outline in diagrams). Dark mode is *ink* surfaces with *paper* text, not blue-grey.

The current site is white `#ffffff` + cool `#17171c`; the component theme `DEFAULT_THEME` is `#f5f4f0`-ish warm surface but cool text `#17171c`. Proposal: docs adopt the tokens below; components then change `DEFAULT_THEME` to the same values in one contract change (`packages/contract/src/theme.ts` is append-only for *token names*, not values, but a value change is visible to all apps: flag it as a deliberate default change with a CHANGELOG note, and keep `primary` customisable).

### Colour tokens (hex; each pair measured with WCAG 2.x)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#FAF9F5` | `#141412` | page |
| `--surface` | `#F1EFE8` (kit paper) | `#1C1C19` | code blocks, cards, active nav |
| `--raised` | `#FFFFFF` | `#232320` | popovers, search modal, inputs |
| `--ink` (headings) | `#1A1A18` (kit ink) | `#F1EFE8` | H1-H3, strong |
| `--body` | `#3A3935` | `#D6D3C8` | paragraphs |
| `--muted` | `#5F5E5A` (kit grey) | `#A3A096` | captions, nav idle, lead |
| `--faint` | `#6E6C66` | `#8E8B81` | metadata, placeholders (still AA) |
| `--border` | `#D9D6CB` | `#34332E` | hairlines (decorative) |
| `--border-strong` | `#8A877E` | `#7A776D` | input and control edges (UI >= 3:1) |
| `--accent` | `#4A3BDC` | `#A69DFF` | links, focus ring, active marker |
| `--accent-soft` | `#E9E6FC` | `#2A2650` | selected row, inline `kbd` highlight |
| `--on-accent` | `#FFFFFF` | `#141412` | text on a solid accent button |
| `--ok` | `#1A6B3C` | `#5FCB8A` | success, "met" |
| `--warn` | `#8A5300` | `#E0A64A` | caution callout |
| `--danger` | `#B42318` | `#FF8A7A` | danger callout, errors |
| `--btn-bg` / `--btn-fg` | `#1A1A18` / `#F1EFE8` | `#F1EFE8` / `#141412` | primary button = ink (the brand's own two tones) |

### Contrast results (WCAG 2.x; needs 4.5 text, 3.0 large text/UI)
**Light**
- ink `#1A1A18` on bg: **16.54** pass
- body `#3A3935` on bg: **10.97** pass
- muted `#5F5E5A` on bg: **6.16**; on surface `#F1EFE8`: **5.64** pass
- faint `#6E6C66` on bg: **4.98**; on surface: **4.56** pass (barely; never use for body)
- accent `#4A3BDC` on bg: **6.76**; on surface: **6.19**; on accent-soft: **5.83** pass
- ok `#1A6B3C`: **6.21**; warn `#8A5300`: **6.01**; danger `#B42318`: **6.24** pass
- border-strong `#8A877E` on bg: **3.41** (>= 3 for UI) pass; border `#D9D6CB`: 1.38 (decorative only; any control edge must use border-strong)
- primary button paper-on-ink: **15.15**; solid accent button white-on-`#4A3BDC`: **7.12** pass

**Dark**
- ink `#F1EFE8` on bg `#141412`: **16.03**; body `#D6D3C8`: **12.31**
- muted `#A3A096`: **7.05** on bg, **6.53** on surface; faint `#8E8B81`: **5.41** / **5.01**
- accent `#A69DFF`: **7.81** on bg, **7.23** on surface, **5.96** on accent-soft
- ok **9.13**, warn **8.54**, danger **8.05**
- border-strong `#7A776D`: **4.12** (UI) pass; solid accent button `#141412` on `#A69DFF`: **7.81**

Every text/background pair passes AA; the lowest text pair is `faint` on `surface` in light at 4.56. Focus ring: 2px `--accent` + 2px offset (6.76:1 on bg, well over 3:1). For reference the current site's paragraph colour is `#5c5a55` on `#fff` = 6.89 (fine) and the product default primary `#5b4cf0` on white is 5.62, on `#FAF9F5` 5.33: usable for links but 4.5-AA margin is thin on tinted surfaces, hence the darker `#4A3BDC`.

### Type
- **Sans: Geist** (OFL; `@fontsource-variable/geist`, latin subset about 30 KB woff2). **Mono: Geist Mono** (`@fontsource-variable/geist-mono`, about 25 KB). Rationale: the kit's wordmark is a Helvetica-style grotesque; Geist is the free, self-hostable neo-grotesque that matches it and the top benchmark sites (Next, shadcn, Clerk numerals). Fallback stack: `"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` with `size-adjust` fallback face to avoid layout shift. Preload only the sans latin woff2; `font-display: swap`; mono is lazy (it is below the fold in most pages). Target total fonts about 55 KB (Next.js spends 91 KB, Clerk 212 KB).
- Wordmark/H1 only: `font-feature-settings: "ss01"` optional; tabular numbers (`font-variant-numeric: tabular-nums`) in tables and error-code lists.

| Step | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| display (landing) | clamp(40px, 5.2vw, 64px) / 1.05 | 600 | -0.035em | landing H1 |
| h1 | 40 / 48 (32 / 40 below 640px) | 600 | -0.03em | page title |
| lead | 18 / 28 (17 / 27 mobile) | 400 | -0.005em | summary under H1 |
| h2 | 26 / 34 | 600 | -0.02em | section |
| h3 | 20 / 28 | 600 | -0.012em | subsection |
| h4 / label | 15 / 22 | 600 | 0 | table heads, sidebar group labels (sentence case, not shouty caps) |
| body | 16 / 28 (1.75, as Next.js) | 400 | 0 | prose |
| small / nav | 14 / 20 | 450 | 0 | sidebar, TOC, meta |
| code | 13.5 / 22 | 400 | 0 | blocks (13px mobile) |
| inline code | 0.875em | 450 | 0 | `padding: .15em .4em` |

Measure: prose `max-width: 720px` = 68-72 characters of Geist 16px (we measured others at 89-121 cpl and that is where long lines hurt readability; 70 is the editorial target).

### Shape, elevation, spacing, motion
- Radius: `--r-sm: 6px` (inputs, kbd, inline code), `--r-md: 10px` (buttons, callouts, code blocks, nav items), `--r-lg: 16px` (cards, search modal), `--r-full` for pills. (Mark's pans are circles: the round `--r-full` pill is used for the page-action buttons and toggle.) Keep `--tula-radius` default of components in sync.
- Spacing: 4px base; 8/12/16/24/32/48/64/96.
- Shadows (warm, ink-tinted): `--sh-1: 0 1px 2px rgb(26 26 24 / .06)`; `--sh-2: 0 1px 2px rgb(26 26 24 / .05), 0 8px 24px rgb(26 26 24 / .08)` (cards on hover, popovers); `--sh-3: 0 24px 64px rgb(26 26 24 / .18)` (search modal). Dark mode replaces shadow with a 1px `--border` ring plus `0 24px 64px rgb(0 0 0 / .5)`.
- Motion: `--ease: cubic-bezier(.2, .8, .2, 1)`; durations 120ms (hover colour), 180ms (disclosure, tab underline), 240ms (modal in: opacity + translateY(8px) + scale(.985)). Only `opacity`, `transform`, `background-color`, `border-color`. Everything off under `prefers-reduced-motion` (already in our CSS). View Transitions API cross-fade between pages (`@view-transition { navigation: auto }`) is a free premium touch on a multi-page site: Chromium and Safari support it; harmless elsewhere.

### Logo usage
Assets from `~/TULA-PROJECTS/logos/tula/svg/` (mark: pole, beam, base, two hangers, solid pan left = AI, open pan right = human; ink `#1A1A18`, paper `#F1EFE8`).
- **Header lockup "Tula Auth":** the kit's horizontal lockup is mark + "tula" (Helvetica Bold 76px, -2 tracking) + "SOLUTION" in `#5F5E5A` letter-spaced caps. For docs build a **product lockup**: mark (24px) + "tula" (Geist 600, -0.03em, ink) + "Auth" in muted grey, and a quiet "Docs" pill (`--surface` bg, 12px, 6px radius). Use the kit's **inline SVG with `currentColor`** (replace the two hex fills with `currentColor`) so one asset serves light and dark, and never rasterise the header logo. Keep the kit's clear-space rule: padding = pan-circle height around the lockup; below 120px width use the mark only (mobile).
- **Favicon:** `icon-app-paper-on-ink` tile (dark) for browsers; ship `favicon.svg` (mark with `prefers-color-scheme` CSS inside the SVG: ink on light, paper on dark), `favicon.ico` 16/32/48, `apple-touch-icon` 180, `pwa-192/512` from the kit's `png/web/`. The site currently serves **no favicon at all** (404).
- **Social / OG (1200x630):** paper `#F1EFE8` background, large mark left of centre in ink, page title in Geist 64/600, "Tula Auth" lockup bottom-left, a faint **balance-line motif** (a 1px horizontal beam through the full width, level) as the one decorative element; dark variant for the landing. Generate per page at build time from an SVG template (satori not needed: plain SVG text + `sharp`/resvg, or one static image for v1 with per-page `og:title`).
- **Premium details, concretely:** (1) the balance motif: the active sidebar item and TOC marker use a short level beam with a filled and an open dot at its ends (an echo of the mark, 6px); (2) code-block language chip uses the solid/open pairing (`TS` solid, `output` outlined); (3) 1px inner top highlight on cards in light mode (`inset 0 1px 0 #fff`), 1px border ring in dark; (4) `::selection` in `--accent-soft`; (5) `scrollbar-color` styled to border; (6) heading anchor `#` appears on hover with 120ms fade, and is copyable; (7) custom `404` with the scale tipped over and a search box; (8) subtle noise-free paper tone (no gradients, no glow, no glassmorphism blur on content; backdrop blur only on the sticky header at 80% bg); (9) numbered Steps rail uses the mark's pan circles (solid for done/current, open for upcoming); (10) tabular numerals everywhere in tables; (11) a `Cmd+K` hint that shows `Ctrl K` on non-Mac via `navigator.platform`; (12) print stylesheet that drops chrome.

---

## (f) Responsive spec

Container: `--shell-max: 1480px` centred (sidebar 264 + gap 48 + prose 720 + gap 48 + TOC 232 + page gutters 2 x 32 = 1,344 content + chrome). Prose is **always** 720px max (`min(100%, 720px)`), never fluid (every benchmark fixes 640-720).

| Viewport | Layout | Details |
|---|---|---|
| **390 x 844** (phone) | single column, 16px gutters | Sticky 56px header: menu, mark, search icon, theme. Sidebar = full-height drawer (focus trap, `inert` main, Esc/back closes, group sections as accordions, current page scrolled into view). TOC collapses into a **sticky "On this page" disclosure** under the H1 (like Next.js does on mobile) with the current section name. Page actions: single "Copy page" icon button + overflow menu (bottom-sheet). Code blocks bleed to the screen edge (`margin-inline: -16px`, no side radius), scroll horizontally, 13px; tables scroll in a labelled `.table-wrap`. Tabs scroll horizontally with snap. Tap targets >= 44px; H1 32/40; body 16px; framework picker as a 2-column grid of cards. `100dvh`, `env(safe-area-inset-*)`. |
| **768 x 1024** (tablet portrait) | single column, 32px gutters, prose up to 720 | Header shows full search pill (no ⌘K hint); sidebar still a drawer (a 264px rail would leave 504px); TOC as the disclosure; cards 2-up; landing hero stacks. |
| **1280 x 800** (laptop) | sidebar 248px + prose (fluid up to 720) | TOC **hidden below 1280**; at exactly 1280 show the TOC only if prose >= 640px remains (`@container`/`min-width: 1320px` for the rail). Today our 1280 shows a 224px TOC (cols at x=1040): keep as is but narrow to 208px. Header tabs visible. |
| **1440 x 900** | sidebar 264 + prose 720 + TOC 232 = full three-column; shell centred with 32px gutters | The reference layout. Page-action bar right of H1 (shadcn placement) or in the rail top (Supabase placement): use the H1-row split button, and the rail holds TOC + "Was this helpful?" + "Edit on GitHub". |
| **1920 x 1080** | same three columns centred in a 1480 shell, side margins grow (220px each) | Optional right rail card ("Open in Claude / Copy as Markdown / MCP") fits below the TOC; sidebar and TOC `position: sticky` with their own scroll; header content aligns to shell edges, header bg full-bleed. |
| **2560 x 1080** (ultrawide) | identical to 1920: **do not stretch**; shell 1480 centred; backdrop is plain `--bg` with a very faint 1px vertical hairline at the shell edges (not required). | Today our 2560 view renders the nav group at about 1,070px and leaves 60% blank; widen to the 1480 shell and raise type one step is *not* needed: proportions stay constant. A ultrawide-only option: allow code blocks that are "wide" (`<Wide>` / file-tree + code side by side) to span prose + rail up to 960px. For 1080px-tall screens set `--sticky-top: 72px` and cap sticky column heights at `calc(100dvh - 96px)` so the sidebar scrolls internally, never the page. |

General rules: logical properties everywhere (`margin-inline`), `scroll-padding-top` = header + 16px, `scroll-margin-top` on every heading, clamp()-based display type only on the landing, `text-wrap: balance` on headings and `text-wrap: pretty` on paragraphs, `overflow-wrap: anywhere` only in tables and inline code (our current `.doc` applies `anywhere` to everything, which hyphenates-breaks identifiers mid-token such as "ghcr.io/tula-solutions/..."), landscape phones (844x390): header not sticky below 500px height. Test matrix = the six viewports x light/dark x JS-off for the shell (the `docs` Playwright project already runs axe and the 375px no-sideways-scroll check; add the 2560 and 768 shots and a visual baseline).

---

## (g) Page-anatomy spec

Top to bottom of `<main>` (all server-rendered; works with no JS):

1. **Breadcrumb** (`nav aria-label="Breadcrumb"`, 14px muted): `Guides / Sign-in methods / Password`; the last segment not a link; derived from the sidebar tree.
2. **Title row:** `h1` (40/48, balance-wrapped) on the left; **page-action split button** on the right: primary "Copy page" (icon + label), chevron menu: *View as Markdown, Open in ChatGPT, Open in Claude, Copy MCP command, Connect to Cursor / VS Code*; beside it, prev/next icon buttons (shadcn).
3. **Lead:** one paragraph, 18/28 muted = the Markdown's first paragraph (or `description` front matter). For method pages add a **metadata chip row**: status (`Stable`, `Beta`, `Not published`), "Off by default" for SMS, SDK availability chips (Web, Expo, Swift, Kotlin), "Updated 2026-10-20".
4. **Banner slot (optional):** a status callout for unpublished SDKs (replaces the large blockquote at the top of the quickstart).
5. **Body:** sections wrapped as today (`data-docs-section`, keep the axe chunking contract); H2 has a hover anchor and `scroll-margin-top`. Components available in Markdown: callouts (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`, 4px left rule + icon + title, `--accent-soft`/`warn`/`danger` tints; GitHub alert syntax degrades gracefully in the repo), Steps (`### 1.` headings inside a `:::steps` fence: numbered rail), Tabs (`:::tabs` with `group="pm"` or `"framework"`; choice stored in `localStorage` and synced across all groups with the same key, default = last picked framework; without JS every panel shows stacked under its label), code groups, FileTree (indented-list fence), Param table (`| Name | Type | Required | Description |` with a type chip and a default column), Response example (collapsed `<details>` with a status pill), Card grid (`<LinkCard>`), Badge. Code block: header row (filename or language, copy button appears on hover/focus, 1.5s check icon), line numbers off by default, `{2,4-6}` highlights as a tinted band + accent left bar, `// [!code ++]` / `--` diff lines with +/- gutters, wrap toggle on mobile; shiki already renders both themes via CSS variables.
6. **Feedback block:** "Was this page helpful?" with two links ("Yes", "No, suggest a fix") opening a prefilled GitHub issue/discussion (`labels=docs`, title includes the route); plus "Edit this page on GitHub" (the file URL we already compute for repo links, on `develop`).
7. **Prev / Next cards** (two cards, title + section label, in sidebar order across tabs).
8. **Footer line:** "Last updated 20 Oct 2026" (`git log -1 --format=%cs -- <source file>` at build; for generated pages use the generation commit), license, link to the `.md` / `llms.txt`.
9. **Right rail (>= 1280):** "On this page" (h2+h3, scroll-spy via one IntersectionObserver, current item with the balance-beam marker, `aria-current="location"`), then the "Ask AI" substitute card: Copy as Markdown · Open in Claude · Open in ChatGPT (links), then Edit/Feedback.

Head: `<title>Password · Tula Auth docs</title>`, canonical, OG/Twitter tags, `<link rel="alternate" type="text/markdown">`, JSON-LD `TechArticle`, `theme-color` per scheme, favicons.

---

## (h) Implementation plan: six independently mergeable slices

Each slice ships alone, keeps `verify` green (including the docs project's axe, page-check and cache-input rules in `.claude/rules/docs-site.md`) and has regression tests that fail first. Because `apps/docs/src/lib/inputs.ts` guards cache inputs, any new generated file that reads a repo file adds its glob to all five `turbo.json` lists in the same slice.

1. **AI-native plumbing (no visual change).** Emit `<route>.md` with front matter, `llms.txt`, `llms-full.txt` (+ `/llms/reference.txt`), `sitemap.xml`, `robots.txt`, `<link rel=alternate type=text/markdown>`, `skill.md` and `.well-known/skills/index.json`; tests: every page has a twin, `llms.txt` lists exactly the sidebar pages, every `.md` link resolves, sizes capped, base path honoured. Add `docs-pages.test.ts` assertions that nothing writes outside `dist`. *Why first:* highest "AI-native" value for lowest risk; independent of the redesign. Effort M. Also: `context7.json` at repo root.
2. **Design system and shell.** Tokens (the table above), Geist fonts, logo lockup (inline `currentColor` SVG), favicons/manifest/OG image, new header, type scale, prose 720 + shell 1480, ultrawide + tablet fixes, sidebar collapse (tabs: Get started / Guides / Components / Self-hosting / CLI & MCP / Reference via `nav.ts` section metadata), dark theme on ink. Update `docs-site.md` rule (tokens no longer only `@tula-tech/contract/theme`: either move the new values into the contract theme in the same PR, preferred, or document the docs overlay). Tests: contrast unit test over the token table (`apps/docs/src/lib/contrast.test.ts`), Playwright screenshots at six widths x two themes, axe. Effort L.
3. **Page anatomy.** Breadcrumb, lead + chips, prev/next, edit-on-GitHub, last-updated (git), feedback links, TOC scroll-spy, heading anchors, page-action menu (copy/view/open in ChatGPT/Claude), Cursor/VS Code MCP install buttons, "For agents" footer. Depends on slices 1 (the `.md` URLs) and 2 for styling, but each piece degrades without them. Effort M.
4. **Content components.** `markdown.ts` extensions: alerts, steps, tabs with persisted group, package-manager tabs (bun first, then npm/pnpm/yarn), code block header/copy/highlight/diff/filename, file tree, param/response tables, card grid; convert quickstart and 2-3 method pages as the exemplars; progressive enhancement and print rules; tests for the grammar and for the no-JS output. Effort L.
5. **Get started and content rewrite.** `/start/` framework picker + five framework quickstarts (Next.js, React, Expo, Swift, Kotlin), "Build with AI" page (agent prompt blocks, rules files, MCP, skill, Context7), a new landing (hero with the one-line promise, `bunx create-tula@latest` command with copy button, framework chooser, three "why Tula" proof points, a live-component screenshot), tone pass (move "what was not verified" to Reference > Status, replace "the steps ... have not been walked yet" with a short status chip). Needs product input: the quickstart's real npm path must be walked once to be the default (today step 1-3 are monorepo-contributor steps and say so). Effort L (content-heavy). The Markdown stays in `docs/`.
6. **Search and reference.** ⌘K palette (`<dialog>`, grouped results: Pages, Sections, Error codes, CLI, API; recent searches), `docs_search`/`docs_read` tools in `@tula-tech/mcp` against the bundled index, OpenAPI-driven **API reference** pages (per-tag, parameter tables, examples, linked error codes), components pages with build-time preview images. Effort L; split further if needed (palette; API reference; MCP tool).

Suggested order: 1 -> 2 -> 3 -> 4 -> 5 -> 6, with 1 and 2 parallelisable by two agents (disjoint files: build outputs vs CSS/layout), and 5's content drafting can start any time.

---

## Critical review of the current site (gaps against the benchmark)

Evidence: captures of the site as it was, `apps/docs/src/{components,lib,styles.css}`, `.claude/rules/docs-site.md`, live `curl` on the Pages URL.

**What is already strong (keep):** 97 KB total weight, 4 requests, DOMContentLoaded 107 ms (benchmarks: 1.2-14 MB); works with no JS; axe on every page in both themes; build-time link/anchor checking; shiki at build; error codes with stable anchors; static search index; theme tokens shared with the product; reduced-motion honoured. These are the hardest things to retrofit and are already best-in-class.

**IA**
- Header is the text "Tula Auth docs" and a search box: no logo, no top navigation, no tabs, no GitHub link, no version.
- Sidebar mirrors `docs/README.md`: 13 groups all expanded (at 1440x900 the viewport shows only 5 groups; the full list is several screens), group names are repository vocabulary ("What your users are sent", "Claims for your backend", "Questions for your backend"), "What was not verified" sits under Start here.
- No framework picker; nothing says Next.js vs React vs Expo vs Swift vs Kotlin on the first screen; five SDKs are the product's headline.
- No API reference (OpenAPI) and no components catalogue, though both are IA slots you want.

**Getting-started friction**
- Quickstart step 1 is "In the Tula repository: docker build ...", step 2 "bun run packages:check", step 3 untars a tarball: this is a contributor flow, and the page itself says the npm path "has not been walked yet". A new user needs `bunx create-tula@latest` first, with the checkout flow as an appendix. No time estimate, no "what you will have at the end", no framework choice.
- The very first thing on the page is a 9-line blockquote of caveats (npm status of three things).

**Content quality and tone**
- Internal voice ("the ones that were run", "stand-in", "not verified", "this version does not do yet") in the main reading path; honest, but a first-time reader needs a status chip, not a confession. Hand-written `docs/README.md` descriptions are long run-on sentences (the Kotlin row is 90 words).
- Method pages are one long section list: no steps, no tabs for Web/Expo/Swift/Kotlin per method, no diagrams, no previews of what the user sees (the product's own screens exist in `docs/design/Design.pdf` and the e2e screenshots).

**Visuals**
- System font stack (renders as SF/Segoe/Roboto depending on OS: no brand voice), 15px body, 24px H1 (smaller than H1s anywhere in the benchmark, which use 30-40px), headings 650 weight untracked.
- No logo, no favicon (404), no OG image (404), no brand accent beyond a blue-ish link colour; the cards on the landing are 8 identical grey boxes with no icon or hierarchy; no hero, no code, no component preview.
- Dark theme is cool blue-black `#17171c`, inconsistent with the warm ink/paper brand.
- Inline-code spacing glitch: in the quickstart callout the text renders as "( ghcr.io/...", "( TULA_API_IMAGE" with a visible gap after an opening parenthesis because the inline `code` has horizontal margin/padding and the text node has a space; also `overflow-wrap: anywhere` on the whole `.doc` lets identifiers break mid-token. Fix in the renderer CSS.
- Code blocks have no header (language/filename), no copy button, no line numbers/highlighting, no diff support, and light-theme token colours include a brown `docker` that clashes with the palette.

**Mobile and ultrawide**
- Mobile (390) works (no sideways scroll, drawer nav, search) but the H1 is 24px, the 9-line callout fills the first screen, the TOC is not available at all (`prevNext`/TOC absent on phones; benchmarks keep a sticky TOC disclosure), tap targets in the sidebar are 30px rows.
- 768 portrait renders prose at 717px (103 cpl) with no sidebar rail.
- Ultrawide (2560): the shell is about 1,070px wide centred: 58% of the screen is empty; content is 599px wide in the image, i.e. small relative to the display. The sidebar scrolls the whole group, with no sticky internal scroll indication.
- Measure of 98-107 characters per line at 15px is well over the 60-75 optimum (only Stripe is wider, at a smaller font).

**AI-native support (measured on the live site)**
- `llms.txt`, `llms-full.txt`, `quickstart.md`/`index.md`, `sitemap.xml`, `robots.txt`, `favicon.ico`, `og.png` are all **404**. No page-level Markdown, no copy-as-Markdown, no open-in-assistant, no MCP install buttons (the MCP server exists in the product and has its own page), no skill file, no rules-file guidance, no Context7 config, no `<link rel=alternate>`. The meta description is the first 150 characters of body text, not a summary.

**Accessibility**
- Good automated coverage (axe, focusable code/table regions, heading order), but: sidebar and TOC links at 13-14px with tight 30px hit area, search is an inline `searchbox` with no `role=dialog`/combobox pattern or keyboard shortcut, no visible skip target beyond the skip link (fine), colour tokens are AA but `textMuted` on `surface` is 5.6:1 only if the new palette keeps it; the TOC has no `aria-current`; no `lang`-level hints on code; reduced-motion fine. Need: ⌘K dialog semantics (`role="dialog"`, listbox with `aria-activedescendant`), `aria-current="page"` and `aria-current="location"`, 44px mobile targets, `forced-colors` rules for borders.

**Performance (keep as a hard budget):** HTML <= 60 KB for a typical page, CSS <= 25 KB, JS <= 12 KB (palette + copy + tabs + scroll-spy), fonts <= 60 KB, no third-party requests, LCP < 1.0 s on 4G, CLS 0 (fallback font metrics), `<link rel=preload>` for the one sans woff2, `content-visibility: auto` on the long reference pages' later sections.

---
