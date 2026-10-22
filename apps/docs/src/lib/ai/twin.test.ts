import { describe, expect, test } from 'bun:test'
import { type LinkEnvironment, LinkError } from '../links'
import { errorCodesMarkdown, frontMatter, renderTwin, twinBody } from './twin'
import { twinPath, type Urls } from './urls'

const urls: Urls = { origin: 'https://docs.example', base: '/sub/' }

const environment: LinkEnvironment = {
  routes: new Map([
    ['docs/quickstart.md', '/quickstart/'],
    ['docs/methods/password.md', '/methods/password/'],
    ['docs/README.md', '/docs/'],
  ]),
  base: '/sub/',
  kind: (path) =>
    [
      'docs/quickstart.md',
      'docs/methods/password.md',
      'docs/README.md',
      'LICENSE',
      'docs/a.png',
    ].includes(path)
      ? 'file'
      : path === 'docs/adr'
        ? 'directory'
        : null,
  anchorsOf: (file) =>
    file === 'docs/methods/password.md' ? new Set(['policy']) : new Set(['top-one']),
}

function twin(source: string, file = 'docs/quickstart.md') {
  return renderTwin({
    file,
    route: '/quickstart/',
    title: 'Quickstart',
    description: 'From nothing: "quoted".',
    section: 'Start here',
    updated: '2026-10-20',
    source,
    environment,
    urls,
    repositoryUrl: 'https://github.example/docs/quickstart.md',
  })
}

describe('urls', () => {
  test('a route is its address without the trailing slash, plus .md', () => {
    expect(twinPath('/')).toBe('index.md')
    expect(twinPath('/docs/')).toBe('docs.md')
    expect(twinPath('/methods/password/')).toBe('methods/password.md')
  })
})

describe('frontMatter', () => {
  test('quotes every value as a JSON string and leaves out an empty one', () => {
    expect(frontMatter({ title: 'A: b', empty: '', none: undefined })).toBe(
      '---\ntitle: "A: b"\n---\n'
    )
  })
})

describe('renderTwin', () => {
  test('has front matter with the title, description, absolute url, source, section and date', () => {
    const text = twin('# Quickstart\n\nHello.\n')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: "Quickstart"')
    expect(text).toContain('description: "From nothing: \\"quoted\\"."')
    expect(text).toContain('url: "https://docs.example/sub/quickstart/"')
    expect(text).toContain('source: "https://github.example/docs/quickstart.md"')
    expect(text).toContain('section: "Start here"')
    expect(text).toContain('updated: "2026-10-20"')
    expect(text).toContain('[llms.txt](https://docs.example/sub/llms.txt)')
    expect(text.endsWith('Hello.\n')).toBe(true)
  })

  test('leaves out the date when the build does not know it', () => {
    const text = renderTwin({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: 'd',
      source: '# Q\n',
      environment,
      urls,
    })
    expect(text).not.toContain('updated')
  })
})

describe('twinBody links', () => {
  test('a link to a page is the absolute address of its twin, anchor kept', () => {
    const body = twinBody({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: '',
      source: '# Q\n\n[pw](methods/password.md#policy) and [home](README.md)\n',
      environment,
      urls,
    })
    expect(body).toContain('[pw](https://docs.example/sub/methods/password.md#policy)')
    expect(body).toContain('[home](https://docs.example/sub/docs.md)')
  })

  test('a link to a repository directory or file is its address on GitHub', () => {
    const body = twinBody({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: '',
      source: '# Q\n\n[adr](adr/) and [licence](../LICENSE)\n',
      environment,
      urls,
    })
    expect(body).toContain(
      '(https://github.com/Tula-Solutions/tula-auth-and-user-management/tree/develop/docs/adr)'
    )
    expect(body).toContain(
      '(https://github.com/Tula-Solutions/tula-auth-and-user-management/blob/develop/LICENSE)'
    )
  })

  test('an image is the copy the site serves under files/, and the same-page anchor is the twin', () => {
    const body = twinBody({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: '',
      source: '# Q\n\n![shot](a.png) [here](#top-one)\n',
      environment,
      urls,
    })
    expect(body).toContain('![shot](https://docs.example/sub/files/docs/a.png)')
    expect(body).toContain('[here](https://docs.example/sub/quickstart.md#top-one)')
  })

  test('a reference definition is rewritten and an external link is left alone', () => {
    const body = twinBody({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: '',
      source: '# Q\n\n[pw][1] [bun](https://bun.sh)\n\n[1]: methods/password.md\n',
      environment,
      urls,
    })
    expect(body).toContain('[1]: https://docs.example/sub/methods/password.md')
    expect(body).toContain('(https://bun.sh)')
  })

  test('a link that does not resolve stops the build', () => {
    expect(() => twin('# Q\n\n[x](missing.md)\n')).toThrow(LinkError)
    expect(() => twin('# Q\n\n[x](methods/password.md#nope)\n')).toThrow('#nope')
  })

  test('snippet markers and other HTML are stripped, the snippet block stays, links in code are not touched', () => {
    const body = twinBody({
      file: 'docs/quickstart.md',
      route: '/quickstart/',
      title: 'Q',
      description: '',
      source:
        '# Q\n\n<!-- snippet: examples/a.ts#x -->\n\n```ts\nconst a = "[x](missing.md)"\n```\n\n<!-- /snippet -->\n\n<div>raw</div>\n\nText.\n',
      environment,
      urls,
    })
    expect(body).not.toContain('<!--')
    expect(body).not.toContain('<div>')
    expect(body).toContain('const a = "[x](missing.md)"')
    expect(body).not.toMatch(/\n{3,}/)
  })
})

describe('errorCodesMarkdown', () => {
  test('has a heading per code with its status and message', () => {
    const text = errorCodesMarkdown([
      { code: 'password.too_short', status: 422, message: 'Too short.', area: 'password' },
      { code: 'rate_limited', status: 429, message: 'Slow down.', area: 'general' },
    ])
    expect(text).toContain('## password\n\n### `password.too_short`\n\nHTTP 422. Too short.')
    expect(text).toContain('### `rate_limited`')
  })
})
