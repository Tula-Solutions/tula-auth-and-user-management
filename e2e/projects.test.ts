import { describe, expect, test } from 'bun:test'
import { serversFor } from './projects'

// Run with the harness tests (`bun run test:harness`): which servers a Playwright run starts
// follows the projects named on its command line.

const PROJECTS = ['nextjs', 'dashboard', 'docs', 'chromium']

describe('serversFor', () => {
  test('no flags: every server', () => {
    expect(serversFor([], {}, PROJECTS)).toEqual({ api: true, docs: true })
  })

  test.each([
    ['--project=docs'],
    ['--project=Docs'],
    ['--project=DOCS'],
    ['--project=do*'],
    ['--project=*cs'],
  ])('%s starts the docs server alone', (flag) => {
    expect(serversFor(['bun', 'playwright', 'test', flag], {}, PROJECTS)).toEqual({
      api: false,
      docs: true,
    })
  })

  test('the space form is read too', () => {
    expect(serversFor(['playwright', 'test', '--project', 'docs'], {}, PROJECTS)).toEqual({
      api: false,
      docs: true,
    })
    expect(serversFor(['playwright', '--project', 'Chromium'], {}, PROJECTS)).toEqual({
      api: true,
      docs: false,
    })
  })

  test('--project is variadic: every value up to the next option is a project', () => {
    expect(serversFor(['--project', 'docs', 'chromium'], {}, PROJECTS)).toEqual({
      api: true,
      docs: true,
    })
    expect(serversFor(['--project', 'nextjs', 'dashboard', '--workers=4'], {}, PROJECTS)).toEqual({
      api: true,
      docs: false,
    })
    expect(serversFor(['--project', 'docs', '--workers', '4'], {}, PROJECTS)).toEqual({
      api: false,
      docs: true,
    })
  })

  test('projects without docs start no docs server', () => {
    expect(
      serversFor(['--project=nextjs', '--project=dashboard', '--project=chromium'], {}, PROJECTS)
    ).toEqual({ api: true, docs: false })
  })

  test('docs together with another project starts both', () => {
    expect(serversFor(['--project=docs', '--project=chromium'], {}, PROJECTS)).toEqual({
      api: true,
      docs: true,
    })
    expect(serversFor(['--project=*'], {}, PROJECTS)).toEqual({ api: true, docs: true })
  })

  test('a pattern that matches nothing starts nothing extra', () => {
    expect(serversFor(['--project=nope'], {}, PROJECTS)).toEqual({ api: true, docs: false })
  })

  test('E2E_DOCS_ONLY=1 alone means the docs server alone', () => {
    expect(serversFor([], { E2E_DOCS_ONLY: '1' }, PROJECTS)).toEqual({ api: false, docs: true })
  })

  test('E2E_DOCS_ONLY=1 is ignored once a project that is not docs is selected', () => {
    expect(serversFor(['--project=nextjs'], { E2E_DOCS_ONLY: '1' }, PROJECTS)).toEqual({
      api: true,
      docs: false,
    })
    expect(
      serversFor(['--project=docs', '--project=chromium'], { E2E_DOCS_ONLY: '1' }, PROJECTS)
    ).toEqual({ api: true, docs: true })
  })

  test('E2E_DOCS_ONLY other than 1 does nothing', () => {
    expect(serversFor([], { E2E_DOCS_ONLY: '0' }, PROJECTS)).toEqual({ api: true, docs: true })
  })
})
