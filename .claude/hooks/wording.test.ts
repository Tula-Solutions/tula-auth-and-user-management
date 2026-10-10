import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// What device binding is called (ADR 0043). The server learns that a refresh was signed by
// the key that started the sign-in. It learns nothing about the device the key is on, the
// app that used it or whose hands it is in. So no text a reader or a user sees calls it
// "device verification", or calls a device "verified" or "trusted": a product that says so
// promises what it cannot know. A session is "bound to a device key".
//
// This test reads the documentation, the READMEs, the React SDK's strings, the contract's
// error messages and the dashboard's sources, and fails for those phrases. It spawns nothing.

const root = resolve(import.meta.dir, '../..')

/** The phrases, over text whose runs of white space are one space (a phrase may wrap). */
const FORBIDDEN = /device[ -]verification|verified[ -]devices?|trusted[ -]devices?/gi

/**
 * Sentences that hold a phrase in order to deny it, by file. An entry is the exact text
 * (white space collapsed), never a file or a pattern: the same phrase anywhere else in the
 * file still fails, and an entry whose sentence is gone fails too.
 */
const ALLOWED: Record<string, string[]> = {
  'docs/adr/0043-device-binding.md': [
    'No text of the product calls this "device verification"',
    'no "trusted device", no key that skips a factor at the next sign-in',
  ],
  'docs/plans/phase-2.md': ['So it is never described as "device verification" in UI or docs.'],
}

/** Text as the check reads it: every run of white space is one space. */
function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * The forbidden phrases a text holds, outside the sentences allowed for it.
 *
 * @param text - A file's content.
 * @param allowed - The exact sentences that may hold a phrase.
 * @returns The phrases found, and the allowed sentences that are not in the text.
 */
function findings(text: string, allowed: string[] = []): { found: string[]; stale: string[] } {
  let rest = collapsed(text)
  const stale: string[] = []
  for (const sentence of allowed) {
    if (!rest.includes(sentence)) {
      stale.push(sentence)
      continue
    }
    // Once: a second copy of an allowed sentence is a new use of the phrase.
    rest = rest.replace(sentence, ' ')
  }
  return { found: [...rest.matchAll(FORBIDDEN)].map((match) => match[0]), stale }
}

const SKIPPED = new Set(['node_modules', 'dist', '.next', '.git', '.turbo', 'test-results'])

/** Every file under a directory that a predicate takes, sorted. */
function walk(directory: string, take: (path: string) => boolean): string[] {
  const found: string[] = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      if (!SKIPPED.has(name)) {
        found.push(...walk(path, take))
      }
    } else if (take(path)) {
      found.push(path)
    }
  }
  return found
}

/** What a reader or a user is shown: the files this rule is about. */
function readFiles(): string[] {
  const files = walk(join(root, 'docs'), (path) => path.endsWith('.md'))
  for (const group of ['packages', 'examples', 'apps']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      files.push(join(root, group, name, 'README.md'))
    }
  }
  files.push(
    join(root, 'README.md'),
    join(root, 'conformance/README.md'),
    join(root, 'e2e/README.md'),
    join(root, 'packages/react/src/localization.ts'),
    join(root, 'packages/contract/src/error-codes.ts'),
    // The dashboard's strings are in its components: every source file but the tests and
    // what a generator writes.
    ...walk(
      join(root, 'apps/dashboard/src'),
      (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.includes('/generated/')
    )
  )
  return files.filter((path) => existsSync(path))
}

describe('the check itself', () => {
  test.each([
    ['Device verification is on.', ['Device verification']],
    ['This is a verified device.', ['verified device']],
    ['Remove a trusted device', ['trusted device']],
    ['your trusted devices', ['trusted devices']],
    ['device-verification', ['device-verification']],
    // A phrase that wraps, as a paragraph of a markdown file does.
    ['no list of trusted\ndevices is kept', ['trusted devices']],
    ['DEVICE   VERIFICATION', ['DEVICE VERIFICATION']],
    ['both: a Verified Device and device verification', ['Verified Device', 'device verification']],
  ])('%p is found', (text, expected) => {
    expect(findings(text).found).toEqual(expected)
  })

  test.each([
    'Bound to a device key',
    'The address is verified. The device is unknown.',
    'A device does not outlive its session.',
    'verification of a device key',
    'a device that is trusted for having signed in before',
  ])('%p is not', (text) => {
    expect(findings(text).found).toEqual([])
  })

  test('an allowed sentence is passed over once, and only as written', () => {
    const sentence = 'It is never called "device verification".'
    expect(findings(`Intro. ${sentence} Outro.`, [sentence])).toEqual({ found: [], stale: [] })
    // Wrapped in the file: still the sentence.
    expect(findings('It is never called\n"device verification".', [sentence]).found).toEqual([])
    // The phrase elsewhere in the same file is still found.
    expect(findings(`${sentence} Turn on device verification.`, [sentence]).found).toEqual([
      'device verification',
    ])
    // A second copy of the sentence is not covered by the one entry.
    expect(findings(`${sentence} ${sentence}`, [sentence]).found).toEqual(['device verification'])
    // An entry whose sentence is gone is reported, so that the list cannot go stale.
    expect(findings('Nothing here.', [sentence])).toEqual({ found: [], stale: [sentence] })
  })

  test('the files read include the docs, a README, the React strings and the dashboard', () => {
    const files = readFiles().map((path) => relative(root, path))
    expect(files).toContain('docs/device-binding.md')
    expect(files).toContain('docs/adr/0043-device-binding.md')
    expect(files).toContain('README.md')
    expect(files).toContain('packages/react/README.md')
    expect(files).toContain('packages/react/src/localization.ts')
    expect(files).toContain('packages/contract/src/error-codes.ts')
    expect(files).toContain('apps/dashboard/src/features/settings/session-profiles-screen.tsx')
    expect(files).toContain('apps/dashboard/src/features/users/user-detail-screen.tsx')
    expect(files.some((path) => path.endsWith('.test.tsx'))).toBe(false)
    expect(files.some((path) => path.includes('/generated/'))).toBe(false)
  })
})

describe('what device binding is called', () => {
  test('no text calls it device verification, or a device verified or trusted', () => {
    const problems: string[] = []
    for (const path of readFiles()) {
      const name = relative(root, path)
      const { found, stale } = findings(readFileSync(path, 'utf8'), ALLOWED[name])
      for (const phrase of found) {
        problems.push(`${name}: "${phrase}" (say "bound to a device key": ADR 0043)`)
      }
      for (const sentence of stale) {
        problems.push(`${name}: the allowed sentence is no longer there: ${sentence}`)
      }
    }
    expect(problems).toEqual([])
  })

  test('every allowed sentence belongs to a file that is read', () => {
    const files = new Set(readFiles().map((path) => relative(root, path)))
    for (const name of Object.keys(ALLOWED)) {
      expect(files.has(name)).toBe(true)
    }
  })
})
