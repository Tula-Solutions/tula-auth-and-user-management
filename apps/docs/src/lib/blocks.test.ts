import { describe, expect, test } from 'bun:test'
import type { Root } from 'mdast'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { BlockError, transformBlocks, twinEdits } from './blocks'

const parser = unified().use(remarkParse).use(remarkGfm)

/** Parse, transform and write a Markdown snippet as HTML (the block nodes become elements). */
function html(source: string): string {
  const tree = parser.parse(source) as Root
  transformBlocks(source, tree)
  const hast = unified().use(remarkRehype, { allowDangerousHtml: true }).runSync(tree)
  return unified().use(rehypeStringify).stringify(hast)
}

/** The error a snippet raises, as the line and the message. */
function failure(source: string): { line: number; message: string } {
  try {
    html(source)
  } catch (error) {
    expect(error).toBeInstanceOf(BlockError)
    return { line: (error as BlockError).line, message: (error as BlockError).message }
  }
  throw new Error('expected the snippet to fail')
}

describe('callouts', () => {
  test.each([
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['CAUTION', 'caution', 'Caution'],
  ])('[!%s] is a callout of its kind with its word as the title', (marker, kind, title) => {
    const out = html(`> [!${marker}]\n> Mind the **gap**.\n`)
    expect(out).toContain(`data-callout="${kind}"`)
    expect(out).toContain('role="note"')
    expect(out).toContain(`<p class="callout-title">${title}</p>`)
    expect(out).toContain('<p>Mind the <strong>gap</strong>.</p>')
    expect(out).not.toContain('[!')
    expect(out).not.toContain('<blockquote')
  })

  test('the marker is read in any case, as GitHub reads it, and later paragraphs stay inside', () => {
    const out = html('> [!note]\n> One.\n>\n> Two.\n')
    expect(out).toContain('data-callout="note"')
    expect(out).toContain('<p>One.</p>')
    expect(out).toContain('<p>Two.</p>')
  })

  test('a block quote without a marker stays a block quote', () => {
    expect(html('> just a quote\n')).toContain('<blockquote>')
  })

  test('a callout inside a list item or another block is found', () => {
    expect(html('- item\n\n  > [!TIP]\n  > nested\n')).toContain('data-callout="tip"')
  })

  test('text on the marker line is refused: GitHub would not draw an alert', () => {
    const error = failure('# T\n\n> [!NOTE] text here\n')
    expect(error.line).toBe(3)
    expect(error.message).toContain('next line')
  })

  test('an unknown kind is refused and the kinds are listed', () => {
    const error = failure('# T\n\n> [!DANGER]\n> no\n')
    expect(error.line).toBe(3)
    expect(error.message).toContain('unknown callout [!DANGER]')
    expect(error.message).toContain('[!CAUTION]')
  })

  test('a callout with no text is refused', () => {
    expect(failure('> [!NOTE]\n').message).toContain('has no text')
  })
})

describe('the fences', () => {
  test('an unknown block fails, with its line, and says which blocks there are', () => {
    const error = failure('# T\n\ntext\n\n:::banner\n\nx\n\n:::\n')
    expect(error.line).toBe(5)
    expect(error.message).toContain('unknown block :::banner')
    expect(error.message).toContain(':::code-group')
  })

  test('a block that is never closed fails at its opening line', () => {
    const error = failure('# T\n\n:::steps\n\n### One\n\ntext\n')
    expect(error.line).toBe(3)
    expect(error.message).toContain('never closed')
  })

  test('a closing fence with nothing open fails', () => {
    const error = failure('# T\n\ntext\n\n:::\n')
    expect(error.line).toBe(5)
    expect(error.message).toContain('no block open')
  })

  test('a fence that shares a paragraph with text fails: GitHub would run them together', () => {
    const error = failure('# T\n\n:::steps\nsome text\n\n### One\n\n:::\n')
    expect(error.line).toBe(3)
    expect(error.message).toContain('stand alone')
  })

  test.each([':::steps extra', ':::Steps{', ':::steps {sync="a"}', '::: steps'])(
    'a malformed fence (%s) fails',
    (fence) => {
      const error = failure(`# T\n\n${fence}\n\n### One\n\n:::\n`)
      expect(error.line).toBe(3)
      expect(error.message).toContain('not a block fence')
    }
  )

  test('a fence inside a code block is code, not a fence', () => {
    const out = html('````markdown\n:::steps\n\n### One\n\n:::\n````\n')
    expect(out).toContain('<pre>')
    expect(out).not.toContain('class="steps"')
  })

  test('attributes must be key="value" pairs, known to the block, once each', () => {
    expect(failure('# T\n\n:::tabs{sync=pm}\n\n#### a\n\nx\n\n:::\n').message).toContain(
      'key="value"'
    )
    expect(failure('# T\n\n:::steps{sync="pm"}\n\n### a\n\n:::\n').message).toContain(
      'has no attribute "sync" (it takes none)'
    )
    expect(failure('# T\n\n:::tabs{color="red"}\n\n#### a\n\nx\n\n:::\n').message).toContain(
      'it takes sync'
    )
    expect(failure('# T\n\n:::tabs{sync="a" sync="b"}\n\n#### a\n\nx\n\n:::\n').message).toContain(
      'sets "sync" twice'
    )
    expect(failure('# T\n\n:::tabs{sync="Not OK"}\n\n#### a\n\nx\n\n:::\n').message).toContain(
      'lower-case'
    )
  })
})

describe(':::steps', () => {
  test('the headings are the steps of a numbered list, and what follows each is inside it', () => {
    const out = html('# T\n\n:::steps\n\n### First\n\nOne.\n\n### Second\n\n- two\n\n:::\n')
    expect(out).toContain('<ol class="steps">')
    expect(out.match(/<li class="step">/g)).toHaveLength(2)
    expect(out).toContain('<h3>First</h3>')
    expect(out).toContain('<li>two</li>')
  })

  test('steps may sit in another block and hold one', () => {
    const out = html(
      '# T\n\n:::steps\n\n### One\n\n:::code-group\n\n```sh title="a"\nx\n```\n\n:::\n\n:::\n'
    )
    expect(out).toContain('class="steps"')
    expect(out).toContain('data-docs-tabs')
  })

  test('the first thing must be a heading, and every heading the same depth', () => {
    expect(failure('# T\n\n:::steps\n\ntext first\n\n### One\n\n:::\n')).toEqual({
      line: 5,
      message: expect.stringContaining('must start with a heading') as unknown as string,
    })
    const mixed = failure('# T\n\n:::steps\n\n### One\n\n#### Deeper\n\n:::\n')
    expect(mixed.line).toBe(7)
    expect(mixed.message).toContain('depth 4')
  })

  test('an empty block fails', () => {
    expect(failure('# T\n\n:::steps\n\n:::\n').message).toContain('is empty')
  })
})

describe(':::tabs and :::code-group', () => {
  test('tabs are panels labelled by their headings, which are not headings of the page', () => {
    const out = html('# T\n\n:::tabs{sync="fw"}\n\n#### Next.js\n\nA.\n\n#### Vite\n\nB.\n\n:::\n')
    expect(out).toContain('class="docs-tabs"')
    expect(out).toContain('data-docs-tabs')
    expect(out).toContain('data-sync="fw"')
    expect(out).toContain('data-kind="tabs"')
    expect(out).toContain('data-label="Next.js"')
    expect(out).toContain('<p class="docs-tab-label">Vite</p>')
    expect(out).not.toContain('<h4')
  })

  test('a group without sync has no key', () => {
    expect(html('# T\n\n:::tabs\n\n#### A\n\nx\n\n:::\n')).not.toContain('data-sync')
  })

  test('tab labels are unique, not empty, and every tab has content', () => {
    expect(failure('# T\n\n:::tabs\n\n#### A\n\nx\n\n#### A\n\ny\n\n:::\n').message).toContain(
      'two tabs labelled "A"'
    )
    expect(failure('# T\n\n:::tabs\n\n#### A\n\n#### B\n\ny\n\n:::\n')).toEqual({
      line: 5,
      message: 'the tab "A" has no content',
    })
  })

  test('a code group takes its tabs from titles, then languages', () => {
    const out = html(
      '# T\n\n:::code-group{sync="pm"}\n\n```sh title="npm" {1}\nnpm i\n```\n\n```sh\nbun add\n```\n\n:::\n'
    )
    expect(out).toContain('data-label="npm"')
    expect(out).toContain('data-label="sh"')
    expect(out).toContain('data-kind="code"')
  })

  test('the title moves to the tab; the line range stays on the block', () => {
    const tree = parser.parse(
      '# T\n\n:::code-group\n\n```sh title="npm" {1}\nnpm i\n```\n\n:::\n'
    ) as Root
    transformBlocks('# T\n\n:::code-group\n\n```sh title="npm" {1}\nnpm i\n```\n\n:::\n', tree)
    const [, group] = tree.children as unknown as {
      children: { children: { meta?: string }[] }[]
    }[]
    expect(group?.children[0]?.children[1]?.meta).toBe('{1}')
  })

  test('a code group holds fenced code and nothing else, and every block has a name', () => {
    expect(failure('# T\n\n:::code-group\n\nplain text\n\n:::\n')).toEqual({
      line: 5,
      message: ':::code-group holds fenced code blocks only (found a paragraph)',
    })
    expect(failure('# T\n\n:::code-group\n\n```\nx\n```\n\n:::\n').message).toContain(
      'needs a title'
    )
    expect(failure('# T\n\n:::code-group\n\n```sh titel="x"\nx\n```\n\n:::\n').message).toContain(
      'titel="x"'
    )
    expect(failure('# T\n\n:::code-group\n\n:::\n').message).toContain('is empty')
  })
})

describe(':::params', () => {
  const table = (rows: string[], head = '| Name | Type | Required | Default | Description |') =>
    `# T\n\n:::params\n\n${head}\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n:::\n`

  test('each row is a parameter: name, type, required, default and a description', () => {
    const out = html(
      table([
        '| `email` | `string` | yes | | The address. |',
        '| `redirect` | `string` | no | `/` | Where to go. |',
      ])
    )
    expect(out).toContain('<dl class="params">')
    expect(out.match(/<div class="param">/g)).toHaveLength(2)
    expect(out).toContain('<span class="param-required">required</span>')
    expect(out.match(/param-required/g)).toHaveLength(1)
    expect(out).toContain('<span class="param-default">Default <code>/</code></span>')
    expect(out).toContain('<dd>The address.</dd>')
  })

  test('only Name and Description are needed, in any order', () => {
    const out = html(
      '# T\n\n:::params\n\n| Description | Name |\n| --- | --- |\n| Says what. | `x` |\n\n:::\n'
    )
    expect(out).toContain('<span class="param-name"><code>x</code></span>')
    expect(out).not.toContain('param-type')
  })

  test('refuses what is not a parameter table', () => {
    expect(failure('# T\n\n:::params\n\ntext\n\n:::\n').message).toContain('holds one table')
    expect(
      failure(table([], '| Name | Colour | Description | Required | Default |')).message
    ).toContain('column "colour"')
    expect(
      failure('# T\n\n:::params\n\n| Name | Type |\n| --- | --- |\n| a | b |\n\n:::\n').message
    ).toContain('no description column')
    const bad = failure(table(['| `a` | `b` | maybe | | d |']))
    expect(bad.message).toContain('"maybe" in the Required column')
    expect(bad.line).toBe(7)
  })
})

describe('twinEdits', () => {
  const edit = (source: string) => {
    const tree = parser.parse(source) as Root
    let text = source
    for (const one of twinEdits(source, tree).sort((a, b) => b.start - a.start)) {
      text = text.slice(0, one.start) + one.text + text.slice(one.end)
    }
    return text.replace(/\n{3,}/g, '\n\n')
  }

  test('the fence lines go and the content stays', () => {
    expect(edit('# T\n\n:::steps\n\n### One\n\ntext\n\n:::\n')).toBe('# T\n\n### One\n\ntext\n\n')
  })

  test('a code group names each block above it, by title or by language', () => {
    const out = edit(
      '# T\n\n:::code-group\n\n```sh title="npm"\nnpm i\n```\n\n```sh\nbun add\n```\n\n:::\n'
    )
    expect(out).toContain('**npm**\n\n```sh title="npm"')
    expect(out).toContain('**sh**\n\n```sh\nbun add')
    expect(out).not.toContain(':::')
  })

  test('a callout is left as written', () => {
    expect(edit('> [!NOTE]\n> text\n')).toBe('> [!NOTE]\n> text\n')
  })

  test('a malformed fence is still reported', () => {
    expect(() => edit('text\n:::steps\n')).toThrow(BlockError)
  })
})
