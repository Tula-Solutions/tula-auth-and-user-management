# Writing docs

Every page of this documentation is a Markdown file in `docs/`. The same file is read on GitHub,
rendered as a page of the [documentation site](../apps/docs/README.md) and served as plain
Markdown to AI agents, so a page is written once, in Markdown that is good in all three. This
page documents every component the site adds to Markdown, each with its source and the result
beside it. It is also the page the site's browser tests use to check the components, so what you
see here is what a reader gets.

The rule behind all of them: **a component is Markdown first**. On GitHub it degrades to a
heading, a list, a block quote or a code block that still reads in order, and in the Markdown
twin of a page (the `.md` file an agent fetches) it is the same plain text with the site-only
lines taken out.

## Callouts

A callout is GitHub's own alert syntax, so it renders on GitHub as well: a block quote whose
first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, with the text on
the lines after it.

````markdown
> [!NOTE]
> Useful information that a reader should know, even when skimming.
````

> [!NOTE]
> Useful information that a reader should know, even when skimming. A note can hold `code`,
> [links](quickstart.md) and more than one paragraph.
>
> A second paragraph stays inside the callout.

> [!TIP]
> Helpful advice for doing something better or more easily.

> [!IMPORTANT]
> Information a reader needs to succeed: skipping it breaks something.

> [!WARNING]
> Urgent information: a step that can lock a user out or lose data if it is done wrongly.

> [!CAUTION]
> The risk of an action that cannot be undone, or that weakens security.

Use them sparingly: a page where everything is a warning has no warnings. The kind is told by
its icon and its word, never by colour alone. Put the text on the line after the marker; GitHub
does not read `> [!NOTE] text` on one line as an alert, so the build refuses it. A plain block
quote (`> text`) is still a quiet note, for a quotation or an aside.

## Steps

A procedure is a `:::steps` container whose headings are the steps. The rail numbers them, and
each heading is a real heading: it has an anchor, and it is in the table of contents.

````markdown
:::steps

### Install the package

Add it to the project.

### Configure it

Tell it where the server is.

:::
````

On GitHub the two `:::` lines show as text and everything between them is a normal list of
sections, so nothing is lost. A blank line goes before and after each `:::` line.

:::steps

### Install the package

Add the client to your project. A step can hold anything a page can: paragraphs, lists, a
table or a code block.

```sh
bun add zod
```

### Configure it

Point it at your server and give it the publishable key. Steps nest with the other components,
so a step can hold [tabs](#tabs) or a [callout](#callouts):

> [!TIP]
> Keep the key in an environment variable, not in the file.

### Run it

That is all. The last step has no line below its number.

:::

All the step headings of one container are the same depth (`###` here), and the first thing in
the container is a heading.

## Tabs

`:::tabs` shows one of several versions of the same content. Each tab starts with a heading,
which is its label. Add `{sync="name"}` to make every group on the site that shares the name
follow the choice, and remember it: a reader who picks Next.js here finds Next.js selected on
every other page.

````markdown
:::tabs{sync="framework"}

#### Next.js

Content for Next.js.

#### Vite

Content for Vite.

:::
````

:::tabs{sync="framework"}

#### Next.js

In a Next.js app the provider goes in the root layout, which is a server component, so it is a
small client component that wraps the children.

> [!NOTE]
> Switch to Vite above and the group below changes with it: they share `sync="framework"`.

#### Vite

In a Vite app the provider wraps the app in `main.tsx`, before the router.

:::

A second group with the same key follows the first:

:::tabs{sync="framework"}

#### Next.js

Run `next dev`.

#### Vite

Run `vite`.

:::

Tabs follow the ARIA tabs pattern: the arrow keys move between them (Home and End go to the
first and the last), the selected tab is the only one in the tab order, and Tab then moves
into the panel. The choice is saved in the browser (`localStorage`) and applied before the
page is first painted, so there is no flash of the wrong tab. **Without script every panel is
shown, each under its label**, and in the Markdown twin the tabs are sections one after the
other. Give each tab a label that is unique within its group, and keep the same labels in every
group that shares a `sync` key.

## Code groups

`:::code-group` is a set of tabs whose panels are fenced code blocks. The tab is named by the
block's `title="…"`, or by its language when it has no title. This is the pattern for a
package manager:

````markdown
:::code-group{sync="package-manager"}

```sh title="bun"
bun add zod
```

```sh title="npm"
npm install zod
```

:::
````

:::code-group{sync="package-manager"}

```sh title="bun"
bun add zod
```

```sh title="npm"
npm install zod
```

```sh title="pnpm"
pnpm add zod
```

```sh title="yarn"
yarn add zod
```

:::

A code group holds fenced code blocks and nothing else. In the Markdown twin each block gets its
tab's name above it, in bold.

## Code blocks

Every code block has a copy button and scrolls sideways when a line is long: nothing wraps, so
a command is never broken across lines. The language after the opening fence picks the colours
(the build refuses a language it does not know, so a typo cannot go unseen).

### A title

`title="…"` names the file the code belongs in.

````markdown
```ts title="app/layout.tsx"
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en">{children}</html>
}
```
````

```ts title="app/layout.tsx"
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en">{children}</html>
}
```

### Highlighted lines

`{1,3-5}` after the language marks lines, by number from 1.

````markdown
```ts title="auth.ts" {4-5}
```
````

```ts title="auth.ts" {4-5}
import { createClient } from './client'

export const auth = createClient({
  baseUrl: process.env.TULA_API_URL,
  publishableKey: process.env.TULA_PUBLISHABLE_KEY,
})
```

A highlighted line has a bar at its edge as well as a tint. A line number past the end of the block fails
the build.

### Changed lines

A comment at the end of a line marks it: `// [!code ++]` for a line added, `// [!code --]` for
a line removed and `// [!code highlight]` for a highlighted line. The comment is taken out of
the block, a `+` or `-` is drawn beside the line so that the change is not told by colour alone,
and the copy button leaves the removed lines out. Use the comment syntax of the language
(`#` in a shell script or YAML).

```ts title="auth.ts"
export const auth = createClient({
  baseUrl: 'http://localhost:3003', // [!code --]
  baseUrl: process.env.TULA_API_URL, // [!code ++]
  publishableKey: process.env.TULA_PUBLISHABLE_KEY,
})
```

A fence in the `diff` language is a diff as `git diff` writes it:

```diff
- "start": "node server.js"
+ "start": "bun run server.ts"
```

## File trees

A fence in the language `tree` is a file tree: one entry a line, indented by a consistent number
of spaces for each level, a name ending in `/` a folder and `# words` after a name its note.

````markdown
```tree
app/
  layout.tsx     # wraps every page
  page.tsx
package.json
```
````

```tree
my-app/
  app/
    layout.tsx        # the provider goes here
    (auth)/
      sign-in/
        page.tsx
      sign-up/
        page.tsx
    page.tsx
  tula.config.ts      # settings as code
  .env                # secrets, never committed
  package.json
  ...
```

On GitHub it is a plain code block, which is how a tree reads best anyway. A tree is a region a
keyboard user can scroll when it is wider than the screen.

## Parameters

`:::params` is a table of the parameters of a call, a request or a response. It is a normal
Markdown table, so GitHub shows it as one; the site draws it as a list of parameters, name and
type first, with the word _required_ beside the ones that are. The columns are `Name`, `Type`,
`Required`, `Default` and `Description`; only the first and the last are needed, in any order.
`Required` is `yes` or `no`.

````markdown
:::params

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `string` | yes | The address to sign up with. |

:::
````

:::params

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `email` | `string` | yes | | The address to sign up with. It is lower-cased, and an address that is already taken is reported only to the owner. |
| `password` | `string` | no | | Left out for a sign-up without a password. Checked against the [password policy](methods/password.md). |
| `redirectUrl` | `string` | no | `/` | Where an emailed link leads. It must be one of the environment's allowed redirect URLs. |
| `metadata` | `object` | no | `{}` | Anything your backend wants to keep with the user. |

:::

## Native screens

`:::native-screens{platform="ios"}` (or `"android"`) shows the pictures of the SwiftUI or the
Compose screens: real screenshots, taken by the example apps' UI tests, in a gallery you can
switch by screen, step and scheme. The text inside the block is the gallery's caption. It is
used on [the Swift page](swift.md#what-the-screens-look-like), [the Kotlin page](kotlin.md#what-the-screens-look-like)
and [the Expo page](expo.md#what-the-screens-look-like), and nowhere else: it is not a place for a
mock-up.

```markdown
:::native-screens{platform="ios"}

These are `TulaAuthView` and `TulaAccountView` as the example app draws them.

:::
```

The pictures are not in the Markdown. They are the files under `apps/docs/public/native/<platform>/`
and a `manifest.json` beside them (the device, the tools, the commit and the date of the run
that made them), written by `bun run native/swift/fixture/ui-tests.ts --screenshots
apps/docs/public/native/ios` and its Android twin ([refreshing the captures](swift.md#refreshing-the-captures)).
The build reads the manifest, so a picture is shown with the words of what made it. On GitHub the
two `:::` lines show as text and the caption reads as a paragraph; there is no picture there, and
the Markdown twin keeps only the caption.

Without a script the gallery is a plain list of every capture, in the reader's scheme. With one it
becomes a picker with tabs for the screens, a button for each step, a switch for the scheme and one
for the device frame. A platform with no manifest says "Not captured yet" and gives the command
that takes the pictures: the site never draws a picture it was not given.

## What the build checks

The site is built from these files, and the build stops, naming the file and the line, for a
component it cannot draw. It is part of `bun run verify`.

| The Markdown | The build says |
| --- | --- |
| `:::banner` | an unknown block, and lists the ones there are |
| `:::steps` with no closing `:::` | the block is never closed |
| A `:::` line with text on the next line | it must stand alone, with a blank line either side |
| `:::tabs{sync=framework}` | the attributes must be `key="value"` pairs |
| A step or tab heading of another depth | a heading of a different depth inside the block |
| Two tabs with one label | two tabs with the same label |
| `> [!INFO]` | an unknown callout, and lists the kinds |
| `> [!NOTE] text` | put the text on the next line |
| A code block in an unknown language | the language is not one the site highlights |
| `titel="…"` or `{1,x}` after a language | the word is not a `title="…"` or a line range |
| A tree indented by a tab, or by two levels at once | the line of the tree |
| `:::native-screens` with no `platform`, or another one | it needs `platform="ios"` or `platform="android"` |
| A `manifest.json` that is not the runners' format, or whose names do not match | the file and what is wrong; nothing is shown from it |

## Writing for the Markdown twin

Every page is also served as Markdown (add `.md` to its address), for people who pipe a page
into a terminal and for AI agents. What a page says in prose, headings, lists, tables and code
survives as it is written. Two things are worth keeping in mind:

- Say what a component shows in the text around it. A tab or a step is a heading in the twin, so
  its title should make sense on its own ("Install with npm", not "Option 2").
- Do not put the only copy of something in an image or in a component's styling: colour,
  position and icons are not in the twin.
