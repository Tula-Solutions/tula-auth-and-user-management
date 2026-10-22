import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { resolveBase } from '../../../apps/docs/src/lib/paths'

// The files for AI agents the docs build writes (llms.txt, a Markdown twin of every page,
// skill.md, the sitemap), fetched from the served site under its base, as an agent would. With
// DOCS_BASE set (`/tula-auth-and-user-management/`, as GitHub Pages serves it) the base is in
// every address; the files name the published origin, so a link is followed by its path.

const BASE = resolveBase()
const ORIGIN = 'https://tula-solutions.github.io'

/** The path under the served site of an absolute address the files name. */
function served(address: string): string {
  expect(address.startsWith(`${ORIGIN}${BASE.slice(0, -1)}/`)).toBe(true)
  return address.slice(ORIGIN.length)
}

const pages = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../../apps/docs/dist/pages.json`, 'utf8')
) as string[]

test.describe('the files for AI agents', () => {
  test('llms.txt is the convention and every .md link in it is served as Markdown', async ({
    request,
  }) => {
    const response = await request.get(`${BASE}llms.txt`)
    expect(response.status()).toBe(200)
    const text = await response.text()
    expect(text.startsWith('# Tula Auth\n\n> ')).toBe(true)
    expect(text).toContain('\n## Start here\n')
    const links = [...text.matchAll(/\]\((https:\/\/tula-solutions\.github\.io[^)]+\.md)\)/g)].map(
      (match) => match[1] as string
    )
    expect(links.length).toBeGreaterThanOrEqual(pages.length)
    // A sample, not all 50: the build's own check resolves every one.
    for (const link of [links[0], links[Math.floor(links.length / 2)], links.at(-1)]) {
      const linked = await request.get(served(link as string))
      expect(linked.status(), link).toBe(200)
      expect((await linked.text()).startsWith('---\n'), link).toBe(true)
    }
  })

  test('a page has a Markdown twin with front matter and absolute links under the base', async ({
    request,
  }) => {
    const response = await request.get(`${BASE}methods/password.md`)
    expect(response.status()).toBe(200)
    const text = await response.text()
    expect(text).toContain('title: "Password"')
    expect(text).toContain(`url: "${ORIGIN}${BASE}methods/password/"`)
    expect(text).toContain(`[llms.txt](${ORIGIN}${BASE}llms.txt)`)
    expect(text).toContain('\n# Password\n')
    expect(text).not.toContain('<!-- snippet')
    expect(text).not.toMatch(/\]\((?!https?:|#)[^)]*\.md/)
  })

  test('the page points at its twin, and skill.md, the sitemap and robots.txt are served', async ({
    page,
    request,
  }) => {
    await page.goto(`${BASE}methods/password/`)
    await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute(
      'href',
      `${BASE}methods/password.md`
    )
    const skill = await (await request.get(`${BASE}skill.md`)).text()
    expect(skill).toContain('name: tula-auth')
    const sitemap = await (await request.get(`${BASE}sitemap.xml`)).text()
    expect(sitemap).toContain(`<loc>${ORIGIN}${BASE}methods/password/</loc>`)
    const robots = await (await request.get(`${BASE}robots.txt`)).text()
    expect(robots).toContain(`Sitemap: ${ORIGIN}${BASE}sitemap.xml`)
  })
})
