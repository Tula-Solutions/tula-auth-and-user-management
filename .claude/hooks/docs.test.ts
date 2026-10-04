import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { withSnippets } from '../../scripts/snippets'

// Guardrails for the documentation: a renamed file or heading, an environment variable added
// without being documented, or a TypeScript sample typed into a method page by hand, fails
// here instead of being found by a reader.

const root = resolve(import.meta.dir, '../..')

/** Every markdown file a reader is sent to: docs/**, the READMEs and the agent instructions. */
function markdownFiles(): string[] {
  const found: string[] = []
  const skip = new Set(['node_modules', 'dist', '.next', '.git', '.turbo', 'test-results'])
  function walk(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        if (!skip.has(name)) {
          walk(path)
        }
      } else if (name.endsWith('.md')) {
        found.push(path)
      }
    }
  }
  walk(join(root, 'docs'))
  for (const group of ['packages', 'examples', 'apps']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      const readme = join(root, group, name, 'README.md')
      if (existsSync(readme)) {
        found.push(readme)
      }
    }
  }
  for (const file of ['README.md', 'AGENTS.md', 'conformance/README.md', 'e2e/README.md']) {
    if (existsSync(join(root, file))) {
      found.push(join(root, file))
    }
  }
  return found
}

/** Markdown without its fenced code blocks and inline code: links in code are not links. */
function prose(markdown: string): string {
  return markdown.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
}

/**
 * The anchor GitHub gives a heading: lower case, punctuation removed, spaces to hyphens, and
 * `-1`, `-2` … appended to a repeated one.
 */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const result = new Set<string>()
  const withoutCode = markdown.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '')
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const text = (match[1] as string)
      // A link in a heading contributes its text only.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-')
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    result.add(count === 0 ? slug : `${slug}-${count}`)
  }
  for (const match of markdown.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) {
    result.add(match[1] as string)
  }
  return result
}

describe('documentation links', () => {
  const files = markdownFiles()

  test('there is documentation to check', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(files).toContain(join(root, 'docs/README.md'))
  })

  test('every relative link leads to a file that exists, and every anchor to a heading', () => {
    const broken: string[] = []
    const anchorsOf = new Map<string, Set<string>>()
    for (const file of files) {
      const text = prose(readFileSync(file, 'utf8'))
      for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const target = match[1] as string
        if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
          continue
        }
        const [path = '', fragment] = target.split('#')
        const destination = path === '' ? file : resolve(dirname(file), decodeURIComponent(path))
        const from = relative(root, file)
        if (!existsSync(destination)) {
          broken.push(`${from}: ${target} (no such file)`)
          continue
        }
        if (fragment === undefined || fragment === '' || !destination.endsWith('.md')) {
          continue
        }
        let known = anchorsOf.get(destination)
        if (!known) {
          known = anchors(readFileSync(destination, 'utf8'))
          anchorsOf.set(destination, known)
        }
        if (!known.has(decodeURIComponent(fragment).toLowerCase())) {
          broken.push(`${from}: ${target} (no such heading)`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  test('the checker itself: slugs as GitHub makes them, and links in code are ignored', () => {
    const page = [
      '# Two-step verification',
      '## `tula doctor`',
      '## What is where?',
      '## What is where?',
      '```md',
      '[not a link](missing.md)',
      '# not a heading',
      '```',
    ].join('\n')
    expect([...anchors(page)]).toEqual([
      'two-step-verification',
      'tula-doctor',
      'what-is-where',
      'what-is-where-1',
    ])
    expect(prose(`${page}\n\`[also not](gone.md)\``)).not.toContain('](')
  })
})

describe('the method pages', () => {
  const directory = join(root, 'docs/methods')
  const pages = [
    'password',
    'email-code',
    'email-link',
    'oauth',
    'passkeys',
    'two-step-verification',
    'sessions',
  ]

  test('there is one page per method, each with the same sections', () => {
    for (const page of pages) {
      const text = readFileSync(join(directory, `${page}.md`), 'utf8')
      for (const heading of [
        '## Switch it on',
        '## What the user sees',
        '## Security properties and limits',
        '## SDK calls',
        '## Troubleshooting',
      ]) {
        expect(`${page}: ${text.includes(`\n${heading}\n`) ? heading : 'missing'}`).toBe(
          `${page}: ${heading}`
        )
      }
      // The reasoning lives in the ADR; the page links to it.
      expect(`${page}: ${/\]\(\.\.\/adr\/\d{4}-[a-z0-9-]+\.md\)/.test(text)}`).toBe(`${page}: true`)
    }
  })

  test('every TypeScript, JSON and YAML sample is copied from a file of the repository', () => {
    // `bun run docs:check` holds a snippet block to its source file, and those files are
    // compiled or validated by their own package. A sample typed into the page is neither.
    const handwritten: string[] = []
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.md'))) {
      const lines = readFileSync(join(directory, name), 'utf8').split('\n')
      lines.forEach((line, index) => {
        const language = /^```(\w+)/.exec(line)?.[1]
        if (!language || ['bash', 'sh', 'text', 'http'].includes(language)) {
          return
        }
        if (!/^<!-- snippet: \S+ -->$/.test(lines[index - 1] ?? '')) {
          handwritten.push(`docs/methods/${name}:${index + 1} (${language})`)
        }
      })
    }
    expect(handwritten).toEqual([])
  })

  test('every error code a troubleshooting section names is one the contract defines', async () => {
    const { ERROR_CODES } = (await import(join(root, 'packages/contract/src/error-codes.ts'))) as {
      ERROR_CODES: Record<string, unknown> | readonly string[]
    }
    const known = new Set(Array.isArray(ERROR_CODES) ? ERROR_CODES : Object.keys(ERROR_CODES))
    // The client's own codes (`@tula/core`, status 0) are not in the contract.
    const clientCodes = new Set([
      'network.failed',
      'network.timeout',
      'response.invalid',
      'storage.failed',
      'flow.busy',
      'link.cross_origin',
      'passkey.unsupported',
      'passkey.cancelled',
      'passkey.already_on_device',
      'passkey.failed',
    ])
    const unknown: string[] = []
    for (const page of pages) {
      const text = readFileSync(join(directory, `${page}.md`), 'utf8')
      const section = text.slice(text.indexOf('\n## Troubleshooting\n'))
      const codes = [...section.matchAll(/^\| `([a-z_]+(?:\.[a-z_]+)?)` \|/gm)].map(
        (match) => match[1] as string
      )
      expect(`${page}: ${codes.length > 0}`).toBe(`${page}: true`)
      for (const code of codes) {
        if (!known.has(code) && !clientCodes.has(code)) {
          unknown.push(`${page}: ${code}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })
})

describe('environment variables', () => {
  const schema = readFileSync(join(root, 'apps/api/src/env.ts'), 'utf8')
  const example = readFileSync(join(root, '.env.example'), 'utf8')
  const guide = readFileSync(join(root, 'docs/self-host.md'), 'utf8')

  /** The variables the API's schema reads. */
  const inSchema = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*): /gm)].map(
    (match) => match[1] as string
  )
  /** Set by tooling, never by an operator: log formatting only (AGENTS.md, "Code style"). */
  const NOT_FOR_OPERATORS = ['NODE_ENV']
  /** In `.env.example` for a script, not for the API: the migrations' owner connection. */
  const SCRIPT_ONLY = ['DATABASE_MIGRATION_URL']
  /** Assigned or commented-out assignments: `NAME=` and `# NAME=`. */
  const inExample = [
    ...new Set(
      [...example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string)
    ),
  ]
  /** The rows of the guide's "Settings" table. */
  const settings = guide.slice(
    guide.indexOf('\n## Settings\n'),
    guide.indexOf('\n## Settings of an environment\n')
  )
  const inGuide = [...settings.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map(
    (match) => match[1] as string
  )

  test('the schema is read: it has the variables everything else depends on', () => {
    expect(inSchema.length).toBeGreaterThan(15)
    for (const name of [
      'ENVIRONMENT',
      'DATABASE_URL',
      'TULA_MASTER_KEY',
      'TRUST_PROXY',
      'REDIS_URL',
    ]) {
      expect(inSchema).toContain(name)
    }
  })

  test('every variable the API reads is in .env.example and in the self-host guide', () => {
    const operator = inSchema.filter((name) => !NOT_FOR_OPERATORS.includes(name))
    expect(operator.filter((name) => !inExample.includes(name))).toEqual([])
    expect(operator.filter((name) => !inGuide.includes(name))).toEqual([])
  })

  test('and nothing is documented that the API does not read', () => {
    const known = [...inSchema, ...SCRIPT_ONLY]
    expect(inExample.filter((name) => !known.includes(name))).toEqual([])
    expect(inGuide.filter((name) => !known.includes(name))).toEqual([])
    // The script-only variable is explained where migrations are.
    for (const name of SCRIPT_ONLY) {
      expect(guide).toContain(`\`${name}\``)
    }
  })
})

describe('snippet sources', () => {
  // `docs:generate` and `docs:check` both fill snippet blocks through `withSnippets`, and what
  // it reads ends up in committed markdown: a marker must not reach a file outside the
  // repository, a local secrets file or a dependency's tree.
  const CANARY = 'canary-7f3a-must-not-be-copied'
  let base: string
  let repository: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'tula-docs-'))
    repository = join(base, 'repository')
    for (const directory of ['examples', 'node_modules/pkg', '.git', 'apps/api']) {
      mkdirSync(join(repository, directory), { recursive: true })
    }
    writeFileSync(join(base, 'outside.txt'), `${CANARY}\n`)
    writeFileSync(join(repository, 'examples/sample.ts'), 'export const sample = 1\n')
    writeFileSync(join(repository, '.env.example'), 'PORT=3003\n')
    for (const secret of ['.env', '.env.local', 'apps/api/.env.production']) {
      writeFileSync(join(repository, secret), `SECRET=${CANARY}\n`)
    }
    writeFileSync(join(repository, 'node_modules/pkg/index.ts'), `// ${CANARY}\n`)
    writeFileSync(join(repository, '.git/config'), `# ${CANARY}\n`)
    symlinkSync(join(base, 'outside.txt'), join(repository, 'examples/link-out.txt'))
    symlinkSync(base, join(repository, 'examples/directory-out'))
    symlinkSync(join(repository, '.env'), join(repository, 'examples/link-to-env.txt'))
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function fill(path: string): string {
    return withSnippets(repository, `<!-- snippet: ${path} -->\n<!-- /snippet -->`, 'docs/page.md')
  }

  test('a file of the repository is copied, and so is .env.example', () => {
    expect(fill('examples/sample.ts')).toContain('export const sample = 1')
    expect(fill('.env.example')).toContain('PORT=3003')
  })

  test.each([
    ['a path that climbs out of the repository', '../outside.txt'],
    ['a path that climbs out and back in', '../repository/../outside.txt'],
    ['an absolute path', '/etc/hosts'],
    ['a symbolic link to a file outside the repository', 'examples/link-out.txt'],
    ['a path through a symbolic link to a directory outside', 'examples/directory-out/outside.txt'],
    ['a symbolic link to a secrets file', 'examples/link-to-env.txt'],
    ['.env', '.env'],
    ['.env.local', '.env.local'],
    ['a nested .env file', 'apps/api/.env.production'],
    ['a secrets file under another spelling', '.ENV'],
    ['a file under node_modules', 'node_modules/pkg/index.ts'],
    ['a file under .git', '.git/config'],
  ])('%s is refused, and the message holds nothing of the file', (_name, path) => {
    let message = ''
    try {
      const filled = fill(path)
      message = `not refused: ${filled.includes(CANARY) ? 'the file was copied' : 'filled'}`
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('docs/page.md')
    expect(message).toContain('not allowed')
    expect(message).not.toContain(CANARY)
    expect(message).not.toContain(base)
  })

  test('an absolute path to a file outside is refused too', () => {
    expect(() => fill(join(base, 'outside.txt'))).toThrow(/not allowed/)
  })
})
