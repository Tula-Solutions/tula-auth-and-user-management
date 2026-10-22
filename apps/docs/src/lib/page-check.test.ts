import { describe, expect, test } from 'bun:test'
import { RenderError, SECTION_CAP } from './markdown'
import { checkPage } from './page-check'

function page(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body><main>${body}</main></body></html>`
}

describe('checkPage', () => {
  test('a well-formed page passes', () => {
    expect(() =>
      checkPage(
        '/ok/',
        page(
          '<h1 id="a">A</h1><div data-docs-section="1"><h2 id="b">B</h2><h3 id="c">C</h3></div><div data-docs-section="2"><h2 id="d">D</h2><nav aria-labelledby="a d">x</nav><label for="in">l</label><input id="in"/></div><h1 id="z">Z</h1>'
        )
      )
    ).not.toThrow()
  })

  test('a heading may go back up any number of levels', () => {
    expect(() =>
      checkPage('/ok/', page('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2><h1>E</h1>'))
    ).not.toThrow()
  })

  test('an h3 after an h1 across a section boundary fails', () => {
    const html = page(
      '<div data-docs-section="0"><h1>A</h1></div><div data-docs-section="1"><h3>C</h3></div>'
    )
    expect(() => checkPage('/skip/', html)).toThrow(RenderError)
    expect(() => checkPage('/skip/', html)).toThrow('/skip/: has an h3 after an h1')
  })

  test('an h4 after an h2 fails, as does a page with no h1', () => {
    expect(() => checkPage('/x/', page('<h1>A</h1><h2>B</h2><h4>D</h4>'))).toThrow('h4 after an h2')
    expect(() => checkPage('/x/', page('<h2>B</h2>'))).toThrow('/x/: has no h1')
  })

  test('headings before the h1, the chrome of the page, are not part of the outline', () => {
    expect(() =>
      checkPage('/ok/', page('<aside><h2>Group</h2></aside><h1>A</h1><h2>B</h2>'))
    ).not.toThrow()
  })

  test('the same id in two sections fails', () => {
    const html = page(
      '<div data-docs-section="0"><h1 id="t">A</h1></div><div data-docs-section="1"><h2 id="dup">B</h2></div><div data-docs-section="2"><h2 id="dup">C</h2></div>'
    )
    expect(() => checkPage('/dup/', html)).toThrow('/dup/: has the id "dup" more than once')
  })

  test.each([
    ['aria-labelledby', '<h1>A</h1><section aria-labelledby="gone">x</section>'],
    ['aria-describedby', '<h1 id="a">A</h1><p aria-describedby="a gone">x</p>'],
    ['for', '<h1>A</h1><label for="gone">l</label>'],
  ])('a dangling %s fails', (attribute, body) => {
    expect(() => checkPage('/ref/', page(body))).toThrow(`"gone" matches no element`)
    expect(() => checkPage('/ref/', page(body))).toThrow(attribute === 'for' ? 'for' : 'aria')
  })
})

describe('checkPage: every address stays under the base path', () => {
  const BASE = '/tula-auth-and-user-management/'

  test('addresses under the base, relative ones, anchors and other sites pass', () => {
    const body = [
      '<h1>A</h1>',
      `<a href="${BASE}quickstart/">q</a>`,
      `<a href="${BASE}">home</a>`,
      '<a href="#part">part</a>',
      '<a href="../x/">up</a>',
      '<a href="https://github.com/Tula-Solutions">gh</a>',
      '<a href="mailto:a@example.com">mail</a>',
      `<img alt="" src="${BASE}files/a.png" srcset="${BASE}files/a.png 1x, ${BASE}files/b.png 2x"/>`,
      `<script src="${BASE}assets/main.js"></script>`,
    ].join('')
    expect(() => checkPage('/ok/', page(body), BASE)).not.toThrow()
  })

  test.each([
    ['a link from the host root', '<a href="/quickstart/">q</a>', '/quickstart/'],
    ['the host root itself', '<a href="/">home</a>', '/'],
    ['a script from the host root', '<script src="/assets/main.js"></script>', '/assets/main.js'],
    [
      'a stylesheet from the host root',
      '<link rel="stylesheet" href="/assets/main.css"/>',
      '/assets/main.css',
    ],
    ['an image from the host root', '<img alt="" src="/files/a.png"/>', '/files/a.png'],
    [
      'one candidate of a srcset',
      `<img alt="" src="${BASE}a.png" srcset="${BASE}a.png 1x, /b.png 2x"/>`,
      '/b.png',
    ],
    ['a form from the host root', '<form action="/search"></form>', '/search'],
    ['a base that only shares a prefix', '<a href="/tula-auth-and-user-management-x/">x</a>', ''],
    ['another host with no scheme', `<a href="//evil.example${BASE}">x</a>`, '//evil.example'],
  ])('%s fails', (_what, body, address) => {
    expect(() => checkPage('/bad/', page(`<h1>A</h1>${body}`), BASE)).toThrow(
      `is outside the base path ${BASE}`
    )
    expect(() => checkPage('/bad/', page(`<h1>A</h1>${body}`), BASE)).toThrow(address)
  })

  test('at the root, an address from the host root is the base, and another host is not', () => {
    expect(() => checkPage('/ok/', page('<h1>A</h1><a href="/quickstart/">q</a>'))).not.toThrow()
    expect(() => checkPage('/bad/', page('<h1>A</h1><a href="//evil.example/">x</a>'))).toThrow(
      'outside the base path /'
    )
  })
})

describe('checkPage section sizes', () => {
  const big = 'x'.repeat(SECTION_CAP + 2000)
  const article = (inner: string) =>
    page(`<h1>T</h1><article><div data-docs-section="0">${inner}</div></article>`)

  test('a section over the cap passes as a single block', () => {
    expect(() => checkPage('/one/', article(`<pre><code>${big}</code></pre>`))).not.toThrow()
  })

  test('a section over the cap in several blocks fails, naming the section', () => {
    const two = `<p>${big}</p><p>more</p>`
    expect(() => checkPage('/two/', article(two))).toThrow(RenderError)
    expect(() => checkPage('/two/', article(two))).toThrow('/two/: has a section 0 over')
  })
})

describe('checkPage on a versioned site', () => {
  const NEXT = '/tula-auth-and-user-management/next/'
  const ROOT = '/tula-auth-and-user-management/'

  test('a link marked as a version link may lead to the other docs, and only to them', () => {
    const ok = page(`<h1>A</h1><a data-docs-version="" href="${ROOT}quickstart/">released</a>`)
    expect(() => checkPage('/ok/', ok, NEXT, ROOT)).not.toThrow()
    const elsewhere = page('<h1>A</h1><a data-docs-version="" href="/other/">x</a>')
    expect(() => checkPage('/bad/', elsewhere, NEXT, ROOT)).toThrow(`outside ${ROOT}`)
  })

  test('an unmarked link from next/ into the released docs fails: it ignored the base', () => {
    const html = page(`<h1>A</h1><a href="${ROOT}quickstart/">q</a>`)
    expect(() => checkPage('/bad/', html, NEXT, ROOT)).toThrow(`is outside the base path ${NEXT}`)
  })

  test('a version link on a site with one version fails', () => {
    const html = page(`<h1>A</h1><a data-docs-version="" href="${ROOT}">x</a>`)
    expect(() => checkPage('/bad/', html, ROOT)).toThrow('only one version')
  })
})
