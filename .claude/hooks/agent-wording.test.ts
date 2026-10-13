import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// What an agent key and the MCP server are said to do (ADR 0053, ADR 0058). Until the
// sign-in test an agent key changed nothing and `@tula/mcp` was read-only, and the product
// said so in many places. Neither is true any more: an agent key runs a sign-in test where
// the environment allows one (a throwaway user, made and deleted), and one tool of the
// server changes live data to do it. A sentence that still says "changes nothing", "reads
// and proposes only" or "read-only" of either is a promise the product no longer keeps, and
// a person decides what key to hand an assistant from exactly those sentences.
//
// This test reads the documentation (the plans excepted), the READMEs, the glossary, the standards document,
// every package's description, the contract's and the admin client's messages, the OpenAPI
// description of the key and the dashboard's sources. It fails for one of the phrases in a
// paragraph that names an agent key or the MCP server. It spawns nothing.

const root = resolve(import.meta.dir, '../..')

/** What a paragraph has to name for the rule to be about it. */
const SUBJECT =
  /agent(?:’s|'s)? keys?|@tula\/mcp|MCP server|Model Context Protocol server|tula mcp/i

/**
 * The phrases. Three things that hold one are not one: how the exception is said ("it
 * changes nothing else", and the dashboard's "changes nothing itself but by running a
 * sign-in test"), the name of a source file (`read-only.ts`), and the name of the facade
 * the read tools go through ("the read-only facade"), which is read-only.
 */
const FORBIDDEN =
  /changes nothing(?! else| itself but)|reads and proposes only|read[- ]only(?!\.ts| facade)/gi

/** Said of an agent wherever it stands: no paragraph has to name the key for these. */
const FORBIDDEN_ANYWHERE =
  /nothing an agent does by itself|route that changes anything answers it/gi

/** Files that are about the MCP server from their first line: every paragraph is. */
const ABOUT_THE_SERVER = new Set(['packages/mcp/README.md', 'packages/mcp/package.json'])

/**
 * Sentences that hold a phrase and are true, by file. An entry is the exact text (white
 * space collapsed), never a file or a pattern: the same phrase anywhere else in the file
 * still fails, and an entry whose sentence is gone fails too.
 */
const ALLOWED: Record<string, string[]> = {
  // The term the glossary tells a reader not to use.
  'GLOSSARY.md': ['_Avoid_: Read-only key'],
  // The decision's title: what was decided then. Its text says what ADR 0058 added.
  'docs/adr/0033-mcp-server.md': [
    '# ADR 0033 — The MCP server (`tula mcp`): read-only tools and scaffolds',
  ],
  // One kind of tool among the server's kinds, in a row that also names the sign-in test.
  'AGENTS.md': [
    'read-only tools over the admin API (users, sessions, audit entries, settings, providers, doctor)',
  ],
}

/** Where one unit of text ends: a blank line, the start of a list item or of a table row. */
const UNIT_BREAK = /\n\s*\n|\n(?=\s*(?:[-*] |\|))/

/** Text as the check reads it: every run of white space is one space. */
function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * The forbidden phrases a text holds, outside the sentences allowed for it.
 *
 * @param text - A file's content.
 * @param allowed - The exact sentences that may hold a phrase.
 * @param everywhere - Whether every paragraph of the file is about the MCP server.
 * @returns The phrases found, and the allowed sentences that are not in the text.
 */
function findings(
  text: string,
  allowed: string[] = [],
  everywhere = false
): { found: string[]; stale: string[] } {
  const found: string[] = []
  const remaining = new Set(allowed)
  // A unit is what a blank line ends, one item of a list or one row of a table: a phrase
  // and its subject wrap, and do not cross one.
  for (const paragraph of text.split(UNIT_BREAK)) {
    let rest = collapsed(paragraph)
    for (const sentence of allowed) {
      if (remaining.has(sentence) && rest.includes(sentence)) {
        // Once: a second copy of an allowed sentence is a new use of the phrase.
        remaining.delete(sentence)
        rest = rest.replace(sentence, ' ')
      }
    }
    found.push(...[...rest.matchAll(FORBIDDEN_ANYWHERE)].map((match) => match[0]))
    if (everywhere || SUBJECT.test(rest)) {
      found.push(...[...rest.matchAll(FORBIDDEN)].map((match) => match[0]))
    }
  }
  return { found, stale: [...remaining] }
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

/** What a reader, a user or a contributor is told: the files this rule is about. */
function readFiles(): string[] {
  // Not `docs/plans/`: a plan records what was true at each step, and stays as written.
  const files = walk(
    join(root, 'docs'),
    (path) => path.endsWith('.md') && !path.includes('/docs/plans/')
  )
  for (const group of ['packages', 'examples', 'apps']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      files.push(join(root, group, name, 'README.md'), join(root, group, name, 'package.json'))
    }
  }
  files.push(
    join(root, 'README.md'),
    join(root, 'GLOSSARY.md'),
    join(root, 'AGENTS.md'),
    join(root, '.claude/rules/api.md'),
    join(root, '.claude/rules/sdk.md'),
    join(root, 'conformance/README.md'),
    join(root, 'packages/contract/src/error-codes.ts'),
    join(root, 'packages/admin/src/errors.ts'),
    // The description of the key in the OpenAPI document, which the clients are made from.
    join(root, 'apps/api/src/openapi.ts'),
    // What `tula mcp` prints about the key it was given.
    join(root, 'packages/cli/src/commands/mcp.ts'),
    // The dashboard's strings are in its components: every source file but the tests and
    // what a generator writes.
    ...walk(
      join(root, 'apps/dashboard/src'),
      (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.includes('/generated/')
    )
  )
  return files.filter((path) => existsSync(path))
}

/** A file's text as the rule reads it: of a manifest, the description and nothing else. */
function textOf(path: string): string {
  const text = readFileSync(path, 'utf8')
  if (!path.endsWith('package.json')) {
    return text
  }
  const { description } = JSON.parse(text) as { description?: unknown }
  return typeof description === 'string' ? description : ''
}

describe('the check itself', () => {
  test.each([
    ['An agent key reads and makes proposals; it changes nothing.', ['changes nothing']],
    ['That is an agent key (tula_ak_…). It reads and proposes only.', ['reads and proposes only']],
    ['`@tula/mcp`: the read-only MCP server', ['read-only']],
    ['the MCP server is read only', ['read only']],
    // A phrase that wraps, as a paragraph of a markdown file does, and its subject lines away.
    ['**Agent key**:\nAn API key for an agent.\nIt changes\nnothing.', ['changes nothing']],
    ['The agent’s key is a Read-Only key.', ['Read-Only']],
    ['there is nothing an agent does by itself', ['nothing an agent does by itself']],
    [
      'every route that changes anything answers it `auth.invalid_key`',
      ['route that changes anything answers it'],
    ],
  ])('%p is found', (text, expected) => {
    expect(findings(text).found).toEqual(expected)
  })

  test.each([
    // How the exception is said.
    'An agent key reads, asks for changes, and runs a sign-in test; it changes nothing else.',
    // Another subject altogether.
    'A webhook is a notice. Its answer changes nothing.',
    'The value is read only when a session is made.',
    // The subject is a paragraph, a list item or a table row away.
    'An agent key is an API key.\n\nA test event changes nothing about an endpoint.',
    '- An agent key is an API key.\n- A second run changes nothing.',
    '| `tula mcp` | The MCP server. |\n| `tula dev` | A second run changes nothing. |',
    // A file's name and the facade's, and the dashboard's way of saying the exception.
    '`@tula/mcp`: tools get `ReadOnlyAdmin` (`read-only.ts`).',
    'With an agent key the reads go through the same read-only facade.',
    'An agent key changes nothing itself but by running a sign-in test.',
  ])('%p is not', (text) => {
    expect(findings(text).found).toEqual([])
  })

  test('in a file about the MCP server every paragraph is read, whatever it names', () => {
    expect(findings('It changes nothing and returns no secret.').found).toEqual([])
    expect(findings('It changes nothing and returns no secret.', [], true).found).toEqual([
      'changes nothing',
    ])
  })

  test('an allowed sentence is passed over once, and only as written', () => {
    const sentence = 'The read tools of the MCP server are annotated read-only.'
    expect(findings(`Intro. ${sentence} Outro.`, [sentence])).toEqual({ found: [], stale: [] })
    // Wrapped in the file: still the sentence.
    expect(
      findings('The read tools of the MCP server\nare annotated read-only.', [sentence]).found
    ).toEqual([])
    // The phrase elsewhere in the same paragraph is still found.
    expect(findings(`${sentence} The MCP server is read-only.`, [sentence]).found).toEqual([
      'read-only',
    ])
    // A second copy of the sentence is not covered by the one entry.
    expect(findings(`${sentence} ${sentence}`, [sentence]).found).toEqual(['read-only'])
    // An entry whose sentence is gone is reported, so that the list cannot go stale.
    expect(findings('Nothing here.', [sentence])).toEqual({ found: [], stale: [sentence] })
  })

  test('the files read include the docs, the glossary, a manifest, the messages and the dashboard', () => {
    const files = readFiles().map((path) => relative(root, path))
    expect(files).toContain('docs/mcp.md')
    expect(files).toContain('docs/proposals.md')
    expect(files).toContain('GLOSSARY.md')
    expect(files).toContain('AGENTS.md')
    expect(files).toContain('README.md')
    expect(files).toContain('packages/mcp/README.md')
    expect(files).toContain('packages/mcp/package.json')
    expect(files).toContain('packages/admin/src/errors.ts')
    expect(files).toContain('packages/contract/src/error-codes.ts')
    expect(files).toContain('apps/api/src/openapi.ts')
    expect(files).toContain('apps/dashboard/src/features/keys/api-keys-screen.tsx')
    expect(files.some((path) => path.endsWith('.test.tsx'))).toBe(false)
    expect(files.some((path) => path.includes('/generated/'))).toBe(false)
  })

  test('of a manifest only the description is read', () => {
    expect(textOf(join(root, 'packages/mcp/package.json'))).toContain('Model Context Protocol')
    expect(textOf(join(root, 'packages/mcp/package.json'))).not.toContain('"dependencies"')
  })
})

describe('what an agent key and the MCP server are said to do', () => {
  test('no text says an agent key changes nothing, or that it or the MCP server is read-only', () => {
    const problems: string[] = []
    for (const path of readFiles()) {
      const name = relative(root, path)
      const { found, stale } = findings(textOf(path), ALLOWED[name], ABOUT_THE_SERVER.has(name))
      for (const phrase of found) {
        problems.push(
          `${name}: "${phrase}" (an agent key runs a sign-in test where the environment allows one: ADR 0058)`
        )
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
