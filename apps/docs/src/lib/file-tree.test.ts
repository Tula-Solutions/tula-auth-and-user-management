import { describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import { parseTree, renderTree } from './file-tree'

function toHtml(node: Element): string {
  return unified()
    .use(rehypeStringify)
    .stringify({ type: 'root', children: [node] } as Root)
}

describe('parseTree', () => {
  test('indentation nests, a trailing slash is a folder and # words are a note', () => {
    const tree = parseTree(
      'app/\n  layout.tsx   # the root\n  (auth)/\n    page.tsx\npackage.json\n'
    )
    expect(tree).toEqual([
      {
        name: 'app',
        directory: true,
        children: [
          { name: 'layout.tsx', directory: false, children: [], note: 'the root' },
          {
            name: '(auth)',
            directory: true,
            children: [{ name: 'page.tsx', directory: false, children: [] }],
          },
        ],
      },
      { name: 'package.json', directory: false, children: [] },
    ])
  })

  test('four-space indentation works as well as two', () => {
    expect(parseTree('a/\n    b/\n        c').at(0)?.children[0]?.children[0]?.name).toBe('c')
  })

  test('blank lines are ignored and a name may hold spaces', () => {
    expect(parseTree('\nMy Folder/\n\n  a b.txt\n')[0]?.children[0]?.name).toBe('a b.txt')
  })

  test.each([
    ['a/\n\tb', 'tab'],
    ['a/\n  b\n   c', 'not a multiple of 2'],
    ['a/\n  b\n      c', 'levels deeper'],
    ['  a', 'levels deeper'],
    ['\n\n', 'no entries'],
  ])('%j is refused (%s)', (source, reason) => {
    expect(() => parseTree(source)).toThrow(reason)
  })

  test('the message names the line of the tree', () => {
    expect(() => parseTree('a/\n  b\n\t\tc')).toThrow('line 3 of the tree')
  })
})

describe('renderTree', () => {
  const out = toHtml(renderTree('app/\n  page.tsx  # home\n...\n'))

  test('is a named, focusable region of nested lists', () => {
    expect(out).toContain('class="file-tree"')
    expect(out).toContain('role="region"')
    expect(out).toContain('aria-label="File tree"')
    expect(out).toContain('tabindex="0"')
    expect(out).toContain('<ul>')
  })

  test('a folder ends in a slash, a file does not, and a note is its own element', () => {
    expect(out).toContain('<span class="tree-name">app/</span>')
    expect(out).toContain('<span class="tree-name">page.tsx</span>')
    expect(out).toContain('<span class="tree-note">home</span>')
    expect(out).toContain('class="tree-dir"')
    expect(out).toContain('class="tree-file"')
  })

  test('an ellipsis is not drawn as a file', () => {
    expect(out).toContain('class="tree-more"')
  })

  test('the icons are decoration: hidden from a screen reader and empty', () => {
    expect(out).toContain('<span class="tree-icon" aria-hidden="true"></span>')
  })
})
