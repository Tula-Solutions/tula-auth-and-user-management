import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// What is said about an app link must not be more than is known (ADR 0044). Tula builds the
// association files; it cannot check that a domain serves them, that an app claims the
// domain, or that a platform hands a link to that app and to no other, and none of it was
// tried on a device. So nothing in the docs, the dashboard or a JSDoc block may promise that
// an app link reaches "only your app". This test keeps such sentences from coming back.

const ROOT = join(import.meta.dir, '..', '..')

/** A promise about who receives a link, in the wordings that have been written before. */
const OVERCLAIMS: readonly RegExp[] = [
  /only your app (can |will |may )?(receive|open|get|claim)s?/i,
  /no other app (can|could|will|may)/i,
  /can(?:not|'t|’t) be claimed/i,
  /only the (registered )?app (can |will )?(receive|open)s?/i,
  /guarantee[sd]? (that )?(only|the app)/i,
]

const WHERE = [
  'docs/native-apps.md',
  'docs/config.md',
  'docs/dashboard.md',
  'docs/providers',
  'docs/adr/0040-native-app-identity.md',
  'docs/adr/0044-app-link-and-custom-scheme-redirects.md',
  'AGENTS.md',
  '.claude/rules',
  '.changeset/app-link-redirects.md',
  'conformance/README.md',
  'conformance/scenarios',
  'apps/dashboard/src/features/native-apps',
  'apps/dashboard/src/features/settings/model.ts',
  'packages/config/src/config.ts',
  'packages/contract/src/native-app.ts',
  'packages/contract/src/redirect-url.ts',
  'packages/cli/src/render.ts',
]

function filesUnder(path: string): string[] {
  const full = join(ROOT, path)
  if (statSync(full).isFile()) {
    return [full]
  }
  return readdirSync(full, { recursive: true })
    .map((entry) => join(full, String(entry)))
    .filter((entry) => statSync(entry).isFile() && !/\.test\.tsx?$/.test(entry))
}

describe('what is said about an app link', () => {
  const files = WHERE.flatMap(filesUnder)

  test('there is something to read', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  test('never promises that only one app receives it', () => {
    const found: string[] = []
    for (const file of files) {
      // Sentences wrap: judge the text with its line breaks and indentation folded.
      const text = readFileSync(file, 'utf8').replace(/\s*\n\s*(?:\*\s*|\/\/\s*)?/g, ' ')
      for (const pattern of OVERCLAIMS) {
        const match = pattern.exec(text)
        if (match) {
          found.push(`${relative(ROOT, file)}: "${match[0]}"`)
        }
      }
    }
    expect(found).toEqual([])
  })

  test('the checker itself: each wording is caught, and what is true is not', () => {
    const caught = (text: string) => OVERCLAIMS.some((pattern) => pattern.test(text))
    for (const text of [
      'Only your app can receive it.',
      'a redirect URL only your app receives',
      'by a link no other app can claim',
      'An https link your registered app opens cannot be claimed that way',
    ]) {
      expect(`${text}: ${caught(text)}`).toBe(`${text}: true`)
    }
    for (const text of [
      'The platform hands the link to the app the domain’s association file names.',
      'any app on a device can claim a custom scheme',
      'Tula cannot check that the domain serves the file',
    ]) {
      expect(`${text}: ${caught(text)}`).toBe(`${text}: false`)
    }
  })

  test('the pages that recommend an app link say what was not checked', () => {
    const page = readFileSync(join(ROOT, 'docs/native-apps.md'), 'utf8').replace(/\s+/g, ' ')
    expect(page).toContain('Tula builds that file and cannot check that your domain serves it')
    expect(page).toContain('None of this has been tested on a device')
  })
})
