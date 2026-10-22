import { beforeAll, describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import { fakeEnvironment } from '../testing/environment'
import { LinkError } from './links'
import {
  createCodeHighlighter,
  type Highlighter,
  linkedFiles,
  markdownAnchors,
  parseMarkdown,
  RenderError,
  renderMarkdown,
  SECTION_ATTRIBUTE,
  wrapSections,
} from './markdown'

const environment = fakeEnvironment(
  {
    'docs/a.md': new Set(['intro', 'second-part']),
    'docs/b.md': new Set(['target']),
    'docs/assets/shot.png': null,
    'docs/adr/1.md': new Set(['why']),
  },
  [],
  { 'docs/a.md': '/a/', 'docs/b.md': '/b/' }
)

let highlighter: Highlighter
beforeAll(async () => {
  highlighter = await createCodeHighlighter()
})

function render(source: string, file = 'docs/a.md') {
  return renderMarkdown(parseMarkdown(file, source), environment, highlighter)
}

describe('parseMarkdown', () => {
  test('headings get the ids GitHub gives them, repeats numbered', () => {
    const doc = parseMarkdown(
      'docs/a.md',
      '# Title\n\n## Switch it on\n\n## Switch it on\n\n## What `x` is?\n'
    )
    expect(doc.headings.map((heading) => heading.id)).toEqual([
      'title',
      'switch-it-on',
      'switch-it-on-1',
      'what-x-is',
    ])
    expect(doc.title).toBe('Title')
  })

  test('the ids a page offers include explicit anchors', () => {
    const doc = parseMarkdown(
      'docs/a.md',
      '# T\n\n<a name="old-name"></a>\n\n<div id="box">x</div>\n'
    )
    expect([...doc.ids]).toEqual(expect.arrayContaining(['t', 'old-name', 'box']))
  })

  test('a file with no top-level heading cannot be a page', () => {
    expect(() => parseMarkdown('docs/a.md', '## Only a second level\n')).toThrow(RenderError)
    expect(() => parseMarkdown('docs/a.md', '## Only a second level\n')).toThrow(
      'docs/a.md: has no top-level'
    )
  })

  test('markdownAnchors reads a file that needs no title', () => {
    expect([...markdownAnchors('docs/x.md', '## Part one\n')]).toEqual(['part-one'])
  })

  test('sections split at ## and ###, leave code out and keep the intro', () => {
    const doc = parseMarkdown(
      'docs/a.md',
      '# T\n\nIntro words.\n\n## One\n\nFirst `inline` text.\n\n```ts\nconst hidden = 1\n```\n\n### Two\n\nSecond.\n'
    )
    expect(doc.sections).toEqual([
      { id: null, title: 'T', text: 'Intro words.' },
      { id: 'one', title: 'One', text: 'First inline text.' },
      { id: 'two', title: 'Two', text: 'Second.' },
    ])
  })
})

describe('renderMarkdown', () => {
  test('comments, snippet markers included, are dropped and the block between stays', () => {
    const { html } = render(
      '# T\n\n<!-- snippet: examples/x.ts#a -->\n\n```ts\nconst a = 1\n```\n\n<!-- /snippet -->\n'
    )
    expect(html).not.toContain('<!--')
    expect(html).not.toContain('snippet:')
    expect(html).toContain('class="shiki')
    expect(html).toContain('const')
  })

  test('code carries both themes as variables and is reachable by keyboard', () => {
    const { html } = render('# T\n\n```bash\nbun install\n```\n')
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('data-language="bash"')
  })

  test('a block with no language is plain text, and an unknown one fails the build', () => {
    expect(render('# T\n\n```\nplain\n```\n').html).toContain('data-language="text"')
    expect(() => render('# T\n\n```cobol\nDISPLAY\n```\n')).toThrow('unknown language "cobol"')
  })

  test('a relative link becomes the page route with its anchor kept', () => {
    const { html } = render('# T\n\nSee [b](b.md#target) and [a](#t).\n')
    expect(html).toContain('href="/b/#target"')
    expect(html).toContain('href="#t"')
  })

  test('a link to a file outside the site goes to GitHub, and an external one opens safely', () => {
    const { html } = render('# T\n\n[adr](adr/1.md#why) [out](https://example.com)\n')
    expect(html).toContain(
      'href="https://github.com/Tula-Solutions/tula-auth-and-user-management/blob/develop/docs/adr/1.md#why"'
    )
    expect(html).toContain('rel="noopener"')
  })

  test('a link that does not resolve fails and names the file', () => {
    expect(() => render('# T\n\n[x](missing.md)\n')).toThrow(LinkError)
    expect(() => render('# T\n\n[x](missing.md)\n')).toThrow('docs/a.md')
  })

  test('an external link with a scheme other than http, https or mailto fails the build', () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
    ]) {
      expect(() => render(`# T\n\n[x](${target})\n`), target).toThrow(RenderError)
      expect(() => render(`# T\n\n[x](${target})\n`), target).toThrow('docs/a.md')
    }
    expect(() =>
      render('# T\n\n[m](mailto:a@example.com) [h](https://example.com)\n')
    ).not.toThrow()
  })

  test('a malformed percent escape in an anchor is a RenderError naming the file', () => {
    expect(() => render('# T\n\n[x](#%E0)\n')).toThrow(RenderError)
    expect(() => render('# T\n\n[x](#%E0)\n')).toThrow('docs/a.md')
  })

  test('an anchor the page or the target lacks fails the build', () => {
    expect(() => render('# T\n\n[x](#nowhere)\n')).toThrow('does not have')
    expect(() => render('# T\n\n[x](b.md#nowhere)\n')).toThrow('does not have')
  })

  test('an image is copied and its address rewritten', () => {
    const { html, assets } = render('# T\n\n![shot](assets/shot.png)\n')
    expect(assets).toEqual(['docs/assets/shot.png'])
    expect(html).toContain('src="/files/docs/assets/shot.png"')
    expect(() => render('# T\n\n![x](b.md)\n')).toThrow('not an image')
  })

  test('a table scrolls in a named box, and an all-empty header row is dropped', () => {
    const { html } = render('# T\n\n| | |\n| --- | --- |\n| one | two |\n')
    expect(html).toContain('class="table-wrap"')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Table 1"')
    expect(html).not.toContain('<thead>')
  })

  test('links in a table cell are resolved like any other', () => {
    const { html } = render('# T\n\n| Where | How |\n| --- | --- |\n| one | [b](b.md#target) |\n')
    expect(html).toContain('href="/b/#target"')
    expect(() => render('# T\n\n| Where | How |\n| --- | --- |\n| one | [x](gone.md) |\n')).toThrow(
      LinkError
    )
  })

  test('an empty header cell next to a named one gets a hidden name', () => {
    const { html } = render('# T\n\n| Name | |\n| --- | --- |\n| one | two |\n')
    expect(html).toContain('<th>Name</th>')
    expect(html).toContain('<span class="sr-only">Column 2</span>')
  })

  test('a heading never skips a level, and keeps its id', () => {
    const { html } = render('# T\n\n## Two\n\n#### Four\n')
    expect(html).toContain('<h3 id="four">Four')
    expect(html).not.toContain('<h4')
  })

  test('a heading gets a permalink that names it', () => {
    const { html } = render('# T\n\n## Two words\n')
    expect(html).toContain('href="#two-words"')
    expect(html).toContain('aria-label="Link to “Two words”"')
  })

  test('rendering leaves the parsed document unchanged, so it can be rendered again', () => {
    const doc = parseMarkdown('docs/a.md', '# T\n\n```ts\nconst a = 1\n```\n')
    const first = renderMarkdown(doc, environment, highlighter).html
    expect(renderMarkdown(doc, environment, highlighter).html).toBe(first)
  })

  test('raw HTML in a page is rendered as HTML, links in it checked like the rest', () => {
    expect(render('# T\n\n<details><summary>s</summary>\n\ntext\n\n</details>\n').html).toContain(
      '<details>'
    )
    expect(() => render('# T\n\n<a href="missing.md">x</a>\n')).toThrow(LinkError)
  })
})

describe('linkedFiles', () => {
  const repo = fakeEnvironment(
    {
      'docs/a.md': new Set(['intro']),
      'docs/b.md': new Set(),
      'packages/zzz/src/a.ts': null,
      'packages/zzz/src/b.ts': null,
      'packages/zzz/src/c.png': null,
      'packages/zzz/README.md': new Set(),
    },
    ['packages/zzz'],
    { 'docs/b.md': '/b/' }
  )

  function files(source: string): string[] {
    return linkedFiles(parseMarkdown('docs/a.md', source), repo)
  }

  test('a reference definition, an inline link, an image and quoted HTML attributes are all read', () => {
    expect(
      files(
        [
          '# T',
          '',
          '[ref]',
          '[inline](b.md)',
          '![i](../packages/zzz/src/c.png)',
          '<a href="../packages/zzz/src/b.ts">double</a>',
          "<a href='../packages/zzz/src/a.ts'>single</a>",
          '',
          '[ref]: ../packages/zzz/src/a.ts',
        ].join('\n')
      ).sort()
    ).toEqual(
      [
        'docs/b.md',
        'packages/zzz/src/a.ts',
        'packages/zzz/src/a.ts',
        'packages/zzz/src/b.ts',
        'packages/zzz/src/c.png',
      ].sort()
    )
  })

  test('external links and bare anchors name no file; a directory names the file it resolves to', () => {
    expect(
      files('# T\n\n[x](https://example.com) [y](#t) [z](mailto:a@b.c) [d](../packages/zzz)\n')
    ).toEqual(['packages/zzz'])
  })

  test('a link that does not resolve fails as it does in a render', () => {
    expect(() => files('# T\n\n[x](missing.md)\n')).toThrow(LinkError)
  })
})

describe('sections', () => {
  const source = [
    '# Title',
    '',
    'Intro.',
    '',
    '## One',
    '',
    'Text one.',
    '',
    '### Sub',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '## Two',
    '',
    'Text two.',
    '',
  ].join('\n')

  test('the content is wrapped in a div for the introduction and one for each h2 and h3', () => {
    const html = render(source).html
    expect(html.match(new RegExp(`<div ${SECTION_ATTRIBUTE}="\\d+">`, 'g'))).toEqual([
      `<div ${SECTION_ATTRIBUTE}="0">`,
      `<div ${SECTION_ATTRIBUTE}="1">`,
      `<div ${SECTION_ATTRIBUTE}="2">`,
      `<div ${SECTION_ATTRIBUTE}="3">`,
    ])
    expect(html).toMatch(new RegExp(`<div ${SECTION_ATTRIBUTE}="1">\\s*<h2 id="one"`))
    expect(html).toMatch(new RegExp(`<div ${SECTION_ATTRIBUTE}="2">\\s*<h3 id="sub"`))
    expect(html).toMatch(new RegExp(`<div ${SECTION_ATTRIBUTE}="0">\\s*<h1`))
    // No landmark or region is added.
    expect(html).not.toContain('<section')
    expect(html).not.toContain('role="region" data-docs-section')
  })

  test('every child of the root is inside exactly one section, in order', () => {
    const root: Root = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'h1', properties: {}, children: [] },
        { type: 'text', value: '\n' },
        { type: 'element', tagName: 'p', properties: {}, children: [] },
        { type: 'element', tagName: 'h2', properties: {}, children: [] },
        { type: 'element', tagName: 'p', properties: {}, children: [] },
        { type: 'element', tagName: 'h2', properties: {}, children: [] },
      ],
    }
    const before = [...root.children]
    wrapSections(root)
    expect(
      root.children.every((child) => child.type === 'element' && child.tagName === 'div')
    ).toBe(true)
    const inside = (root.children as Element[]).flatMap((section) => section.children)
    expect(inside as unknown[]).toEqual(before)
    expect((inside as unknown[]).every((child, index) => child === before[index])).toBe(true)
  })

  test('a page that starts with an h2 has no empty introduction section', () => {
    const root: Root = {
      type: 'root',
      children: [{ type: 'element', tagName: 'h2', properties: {}, children: [] }],
    }
    wrapSections(root)
    expect(root.children).toHaveLength(1)
  })
})
