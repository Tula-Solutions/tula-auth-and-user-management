import { describe, expect, test } from 'bun:test'
import { checkAiFiles } from './check'
import { LLMS_FULL_CAP, LLMS_TXT_CAP } from './llms'
import type { Urls } from './urls'

const urls: Urls = { origin: 'https://docs.example', base: '/sub/' }
const own = 'https://docs.example/sub'

function good(): Map<string, string> {
  return new Map([
    ['index.md', '# Home\n'],
    [
      'quickstart.md',
      `# Quickstart\n\nSee [home](${own}/index.md) and [it](${own}/quickstart.md#step).\n`,
    ],
    ['llms.txt', `# T\n\n- [Home](${own}/index.md)\n- [Quickstart](${own}/quickstart.md)\n`],
    ['llms-full.txt', '# T\n'],
  ])
}

const pages = new Map<string, ReadonlySet<string>>([
  ['/', new Set()],
  ['/quickstart/', new Set(['step'])],
])

function check(files: Map<string, string>, copied: string[] = []) {
  checkAiFiles({ urls, files, pages, copied: new Set(copied) })
}

describe('checkAiFiles', () => {
  test('accepts a consistent set of files', () => {
    expect(() => check(good())).not.toThrow()
  })

  test('fails for a page without a Markdown twin, naming the page', () => {
    const files = good()
    files.delete('quickstart.md')
    expect(() => check(files)).toThrow('/quickstart/: has no Markdown twin')
  })

  test('fails for a link in a twin that finds no file, naming the file and the address', () => {
    const files = good()
    files.set('quickstart.md', `# Q\n\n[gone](${own}/missing.md)\n`)
    expect(() => check(files)).toThrow(/quickstart\.md.*missing\.md/)
  })

  test('fails for a link in a twin to an anchor the page does not have', () => {
    const files = good()
    files.set('quickstart.md', `# Q\n\n[x](${own}/quickstart.md#nope)\n`)
    expect(() => check(files)).toThrow('#nope')
  })

  test('fails for a link in llms.txt that finds no file', () => {
    const files = good()
    files.set('llms.txt', `${files.get('llms.txt')}- [Gone](${own}/gone.md)\n`)
    expect(() => check(files)).toThrow(/llms\.txt.*gone\.md/)
  })

  test('fails for a page llms.txt leaves out', () => {
    const files = good()
    files.set('llms.txt', `# T\n\n- [Home](${own}/index.md)\n`)
    expect(() => check(files)).toThrow('llms.txt: does not list /quickstart/')
  })

  test('fails for an llms.txt over its cap', () => {
    const files = good()
    files.set('llms.txt', `${files.get('llms.txt')}${'x'.repeat(LLMS_TXT_CAP)}`)
    expect(() => check(files)).toThrow('over the cap')
  })

  test('fails for an llms-full.txt one character over its cap, and passes at the cap', () => {
    const files = good()
    files.set('llms-full.txt', 'x'.repeat(LLMS_FULL_CAP))
    expect(() => check(files)).not.toThrow()
    files.set('llms-full.txt', 'x'.repeat(LLMS_FULL_CAP + 1))
    expect(() => check(files)).toThrow(
      'llms-full.txt: is 1500001 characters, over the cap of 1500000'
    )
  })

  test('accepts a link to a page, to a copied image and to the base itself; leaves other hosts alone', () => {
    const files = good()
    files.set(
      'quickstart.md',
      `# Q\n\n[p](${own}/quickstart/#step) ![i](${own}/files/docs/a.png) [h](${own}/) [e](https://elsewhere.example/sub/x)\n`
    )
    expect(() => check(files, ['files/docs/a.png'])).not.toThrow()
  })

  test('an address outside the base is not this site: only the base is held to the check', () => {
    const files = good()
    files.set('quickstart.md', '# Q\n\n[x](https://docs.example/other/missing.md)\n')
    expect(() => check(files)).not.toThrow()
  })
})
