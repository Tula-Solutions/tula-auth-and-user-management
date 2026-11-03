import { beforeAll, describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import { fakeEnvironment } from '../testing/environment'
import { LinkError } from './links'
import {
  createCodeHighlighter,
  type Highlighter,
  markdownAnchors,
  parseMarkdown,
  RenderError,
  renderMarkdown,
  SECTION_ATTRIBUTE,
  SECTION_CAP,
  titleOf,
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

  test('titleOf finds the title the full parse finds, reading only the lines before a ##', () => {
    const sources = [
      '# The `code` title\n\nIntro.\n\n## Part\n\n# Another top heading\n',
      '# Only\n',
      'Intro first.\n\n## Early\n\n# Late title\n',
      '```\n## in a fence\n```\n\n# After a fence\n',
    ]
    for (const source of sources) {
      expect(titleOf('docs/x.md', source)).toBe(parseMarkdown('docs/x.md', source).title)
    }
    expect(titleOf('docs/x.md', sources[0] as string)).toBe('The code title')
    expect(() => titleOf('docs/x.md', '## No title\n')).toThrow('has no top-level')
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

describe('the files a render links to', () => {
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
    return renderMarkdown(parseMarkdown('docs/a.md', source), repo, highlighter).files
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

  describe('a section that grows past the cap', () => {
    function block(tag: string, size: number): Element {
      return {
        type: 'element',
        tagName: tag,
        properties: {},
        children: [{ type: 'text', value: 'x'.repeat(size) }],
      }
    }

    test('is closed at the next block boundary and goes on in a new section', () => {
      const third = Math.floor(SECTION_CAP / 3) + 1
      const root: Root = {
        type: 'root',
        children: [
          block('h1', 10),
          block('h2', 10),
          block('p', third),
          block('p', third),
          block('p', third),
          block('h4', 10),
          block('p', third),
        ],
      }
      const before = [...root.children]
      wrapSections(root)
      const sections = root.children as Element[]
      // The introduction; the h2 with two paragraphs (a third would pass the cap); the third, h4 and last.
      expect(sections.map((section) => section.children.length)).toEqual([1, 3, 3])
      expect(sections.map((section) => section.properties?.[SECTION_ATTRIBUTE])).toEqual([
        '0',
        '1',
        '2',
      ])
      // Nothing is lost or moved.
      expect(sections.flatMap((section) => section.children) as unknown[]).toEqual(before)
    })

    test('a block bigger than the cap is a section of its own, and only it', () => {
      const root: Root = {
        type: 'root',
        children: [block('h2', 10), block('table', SECTION_CAP * 3), block('p', 10)],
      }
      wrapSections(root)
      const sections = root.children as Element[]
      expect(sections.map((section) => section.children.length)).toEqual([1, 1, 1])
    })

    test('a rendered page has no section over the cap but a single block', () => {
      const html = render(
        [
          '# T',
          '',
          '## A',
          '',
          ...Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${'y'.repeat(600)}\n`),
        ].join('\n')
      ).html
      const sizes = html
        .split(`<div ${SECTION_ATTRIBUTE}="`)
        .slice(1)
        .map((part) => part.length)
      expect(sizes.length).toBeGreaterThan(2)
      for (const size of sizes) {
        expect(size).toBeLessThanOrEqual(SECTION_CAP + 1000)
      }
    })
  })
})

describe('the content components', () => {
  test('a callout, steps, tabs and a parameter table are written as the elements the stylesheet draws', () => {
    const { html } = render(
      [
        '# T',
        '',
        '> [!WARNING]',
        '> Careful.',
        '',
        ':::steps',
        '',
        '### One',
        '',
        'x',
        '',
        ':::',
        '',
        ':::params',
        '',
        '| Name | Description |',
        '| --- | --- |',
        '| `a` | b |',
        '',
        ':::',
        '',
      ].join('\n')
    )
    expect(html).toContain('data-callout="warning"')
    expect(html).toContain('<ol class="steps">')
    expect(html).toContain('<h2 id="one">One<a class="permalink"')
    expect(html).toContain('<dl class="params">')
  })

  test('a step is a heading of the page: it has an anchor, and the outline has no hole', () => {
    const doc = parseMarkdown('docs/a.md', '# T\n\n## S\n\n:::steps\n\n### One\n\nx\n\n:::\n')
    expect(doc.headings.map((heading) => heading.id)).toEqual(['t', 's', 'one'])
    expect(render('# T\n\n## S\n\n:::steps\n\n### One\n\nx\n\n:::\n').html).toContain(
      '<h3 id="one"'
    )
  })

  test('a tab label is not a heading, so it is not in the outline or an anchor', () => {
    const doc = parseMarkdown(
      'docs/a.md',
      '# T\n\n:::tabs\n\n#### Vite\n\nx\n\n#### Next\n\ny\n\n:::\n'
    )
    expect(doc.headings.map((heading) => heading.text)).toEqual(['T'])
    expect([...doc.ids]).not.toContain('vite')
  })

  describe('tabs', () => {
    const tabs = (name: string) =>
      `:::tabs{sync="fw"}\n\n#### A${name}\n\nx\n\n#### B\n\ny\n\n:::\n`

    test('the first set of tabs carries the runtime and each later one only calls it', () => {
      const { html } = render(`# T\n\n${tabs('1')}\n${tabs('2')}\n${tabs('3')}`)
      expect(html.match(/<script>/g)).toHaveLength(3)
      expect(html.match(/function tabsRuntime/g)).toHaveLength(1)
      expect(html.match(/window\.__docsTabs&&window\.__docsTabs\(\)/g)).toHaveLength(2)
      // The script follows its own group, so that the group is tabs before it is painted.
      expect(html.indexOf('data-docs-tabs')).toBeLessThan(html.indexOf('<script>'))
    })

    test('a page with no tabs has no tabs script', () => {
      expect(render('# T\n\ntext\n').html).not.toContain('<script')
    })

    test('the script is not text of the page: it is not searched', () => {
      const doc = parseMarkdown('docs/a.md', `# T\n\n## S\n\n${tabs('')}`)
      const built = renderMarkdown(doc, environment, highlighter)
      expect(built.html).toContain('tabsRuntime')
      expect(doc.sections.map((section) => section.text).join(' ')).not.toContain('localStorage')
    })

    test('the runtime is plain JavaScript that parses', () => {
      const source = render(`# T\n\n${tabs('')}`).html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
      expect(source).toBeDefined()
      expect(() => new Function(source as string)).not.toThrow()
      expect(source).not.toMatch(/\): (void|string|boolean)\b|\bas unknown\b/)
    })
  })

  describe('code blocks', () => {
    test('a block is a frame with a copy button and a live region, and a title when it has one', () => {
      const { html } = render('# T\n\n```ts title="app/layout.tsx"\nconst a = 1\n```\n')
      expect(html).toContain('class="code-block"')
      expect(html).toContain('data-titled')
      expect(html).toContain('<span class="code-title-text">app/layout.tsx</span>')
      expect(html).toContain('aria-label="Copy app/layout.tsx"')
      expect(html).toContain('role="status"')
      expect(html).toContain('aria-live="polite"')
      expect(html).toContain('data-language="ts"')
    })

    test('an untitled block says "Copy code" and has no title bar', () => {
      const { html } = render('# T\n\n```sh\nls\n```\n')
      expect(html).toContain('aria-label="Copy code"')
      expect(html).not.toContain('code-title')
    })

    test('the copy button is never hidden by an attribute: the stylesheet shows it only with script', () => {
      expect(render('# T\n\n```sh\nls\n```\n').html).not.toMatch(/<button[^>]*hidden/)
    })

    test('{1,3-5} marks lines, and each marked line is a line', () => {
      const { html } = render('# T\n\n```ts {2,3}\na\nb\nc\nd\n```\n')
      expect(html.match(/class="line highlighted"/g)).toHaveLength(2)
      expect(html.match(/class="line"/g)).toHaveLength(2)
    })

    test('// [!code ++] and -- tint the lines and are taken out of the code', () => {
      const { html } = render(
        '# T\n\n```ts\nconst a = 1 // [!code --]\nconst a = 2 // [!code ++]\nconst b = 3 // [!code highlight]\n```\n'
      )
      expect(html).toContain('class="line diff remove"')
      expect(html).toContain('class="line diff add"')
      expect(html).toContain('class="line highlighted"')
      expect(html).not.toContain('[!code')
    })

    test('a diff block tints the lines that start with + and -', () => {
      const { html } = render('# T\n\n```diff\n- old\n+ new\n  same\n```\n')
      expect(html).toContain('class="line diff remove"')
      expect(html).toContain('class="line diff add"')
      expect(html.match(/class="line"/g)).toHaveLength(1)
    })

    test('a code group tab carries the block with no title bar of its own', () => {
      const { html } = render('# T\n\n:::code-group\n\n```sh title="npm"\nnpm i\n```\n\n:::\n')
      expect(html).toContain('data-label="npm"')
      expect(html).not.toContain('code-title')
    })

    test('a malformed info string fails with the file and the line of the block', () => {
      expect(() => render('# T\n\ntext\n\n```ts titel="x"\na\n```\n')).toThrow(
        'docs/a.md: line 5: the code block\'s "titel="x"" is not a title'
      )
    })

    test('a line range past the end fails with the line', () => {
      expect(() => render('# T\n\n```ts {1,9}\na\nb\n```\n')).toThrow(
        'docs/a.md: line 3: the line range {9} is past the end of a block of 2 lines'
      )
    })

    test('an unknown language still fails, and now says where', () => {
      expect(() => render('# T\n\n```klingon\na\n```\n')).toThrow(
        'has a code block in an unknown language "klingon" (line 3)'
      )
    })
  })

  describe('trees', () => {
    test('a tree fence is a file tree, not a code block', () => {
      const { html } = render('# T\n\n```tree\napp/\n  page.tsx\n```\n')
      expect(html).toContain('class="file-tree"')
      expect(html).not.toContain('code-block')
    })

    test('a tree takes no title, and a tree that cannot be read fails with its line', () => {
      expect(() => render('# T\n\n```tree title="x"\napp/\n```\n')).toThrow(
        'docs/a.md: line 3: a tree block takes no title'
      )
      expect(() => render('# T\n\n```tree\napp/\n\tpage.tsx\n```\n')).toThrow(
        'docs/a.md: line 3: line 2 of the tree is indented with a tab'
      )
    })
  })

  describe('errors', () => {
    test('an unknown block is a RenderError naming the file and the line', () => {
      expect(() => render('# T\n\ntext\n\n:::banner\n\nx\n\n:::\n')).toThrow(
        'docs/a.md: line 5: unknown block :::banner'
      )
    })

    test('the error of a block is raised when the page is parsed, so the whole build stops on it', () => {
      expect(() => parseMarkdown('docs/a.md', '# T\n\n:::steps\n\n### a\n')).toThrow(RenderError)
    })
  })
})
