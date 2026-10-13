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
import { codeOnly, NATIVE_SDKS, nativeDeclarations } from '../../scripts/native-reference'
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
  // The rules of one area, which `AGENTS.md` sends an agent to (and which link to the ADRs).
  for (const name of readdirSync(join(root, '.claude/rules')).sort()) {
    if (name.endsWith('.md')) {
      found.push(join(root, '.claude/rules', name))
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
    'sms-code',
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
    // The client's own codes (`@tula-tech/core`, status 0) are not in the contract.
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
    for (const directory of ['examples', 'node_modules/pkg', '.git', 'apps/api', '.claude']) {
      mkdirSync(join(repository, directory), { recursive: true })
    }
    writeFileSync(join(base, 'outside.ts'), `${CANARY}\n`)
    writeFileSync(join(repository, 'examples/sample.ts'), 'export const sample = 1\n')
    writeFileSync(join(repository, '.env.example'), 'PORT=3003\n')
    for (const secret of [
      '.env',
      '.env.local',
      'apps/api/.env.production',
      // Not `.env` files, and not anything the generator has a language for either.
      '.npmrc',
      'a.pem',
      'key.key',
      'examples/notes.txt',
      'examples/Makefile',
      // A known extension, but a machine's own settings, which git ignores.
      '.claude/settings.local.json',
    ]) {
      writeFileSync(join(repository, secret), `SECRET=${CANARY}\n`)
    }
    writeFileSync(join(repository, 'node_modules/pkg/index.ts'), `// ${CANARY}\n`)
    writeFileSync(join(repository, '.git/config'), `# ${CANARY}\n`)
    symlinkSync(join(base, 'outside.ts'), join(repository, 'examples/link-out.ts'))
    symlinkSync(base, join(repository, 'examples/directory-out'))
    symlinkSync(join(repository, '.env'), join(repository, 'examples/link-to-env.ts'))
    symlinkSync(join(repository, 'key.key'), join(repository, 'examples/link-to-key.ts'))
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

  test('a region of a Swift or a Kotlin source is copied under its own language', () => {
    // The native SDKs' samples are regions of sources their builds compile.
    const source = '    // #region call\n    let a = 1\n    // #endregion\n    let b = 2\n'
    writeFileSync(join(repository, 'examples/Sample.swift'), source)
    writeFileSync(join(repository, 'examples/Sample.kt'), source)
    for (const [file, language] of [
      ['examples/Sample.swift', 'swift'],
      ['examples/Sample.kt', 'kotlin'],
    ]) {
      const filled = fill(`${file}#call`)
      expect(filled).toContain(`\`\`\`${language}\nlet a = 1\n\`\`\``)
      expect(filled).not.toContain('let b = 2')
    }
  })

  test.each([
    ['a path that climbs out of the repository', '../outside.ts'],
    ['a path that climbs out and back in', '../repository/../outside.ts'],
    ['an absolute path', '/etc/hosts'],
    ['a symbolic link to a file outside the repository', 'examples/link-out.ts'],
    ['a path through a symbolic link to a directory outside', 'examples/directory-out/outside.ts'],
    ['a symbolic link to a secrets file', 'examples/link-to-env.ts'],
    ['.env', '.env'],
    ['.env.local', '.env.local'],
    ['a nested .env file', 'apps/api/.env.production'],
    ['a secrets file under another spelling', '.ENV'],
    ['a file under node_modules', 'node_modules/pkg/index.ts'],
    ['a file under .git', '.git/config'],
    ['.npmrc (no extension the generator knows)', '.npmrc'],
    ['a certificate or key in PEM', 'a.pem'],
    ['a .key file', 'key.key'],
    ['a plain text file', 'examples/notes.txt'],
    ['a file with no extension', 'examples/Makefile'],
    ['a machine-local settings file', '.claude/settings.local.json'],
    ['a link with a known extension to a file without one', 'examples/link-to-key.ts'],
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
    expect(() => fill(join(base, 'outside.ts'))).toThrow(/not allowed/)
  })
})

describe('the native reference', () => {
  const names = (text: string, language: 'swift' | 'kotlin') =>
    nativeDeclarations(text, language, 'Sample').map((entry) => entry.name)

  test('every native module has its sources and every native SDK its page', () => {
    for (const sdk of NATIVE_SDKS) {
      expect(existsSync(join(root, 'docs/reference', sdk.page))).toBe(true)
      for (const module of sdk.modules) {
        expect(statSync(join(root, module.directory)).isDirectory()).toBe(true)
      }
    }
  })

  test('a brace in a string, a raw string or a comment is not code', () => {
    const swift = 'let a = "{ \\(b { "}" }) }" // {\nlet c = #"[{}"]"# /* { /* { */ } */\n'
    const cleaned = codeOnly(swift, 'swift')
    expect(cleaned).toHaveLength(swift.length)
    expect(cleaned).not.toMatch(/[{}]/)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Kotlin string template is the case under test
    const kotlin = 'val a = "{ ${b.map { "}" }} }" // {\nval c = \'{\' /* } */\nval d = """{"""\n'
    expect(codeOnly(kotlin, 'kotlin')).not.toMatch(/[{}]/)
  })

  test('Swift: what is public is listed, with its doc comment, and nothing else', () => {
    const found = nativeDeclarations(
      [
        '/// A client.',
        '///',
        '/// More.',
        'public final class Client: Sendable {',
        '    /// Signs out.',
        '    @discardableResult',
        '    public func signOut(',
        '        everywhere: Bool = false',
        '    ) async throws -> Bool {',
        '        let local = "{"',
        '        return true',
        '    }',
        '    func hidden() {}',
        '    private var secret = 1',
        '    public private(set) var state: Int = 0',
        '}',
        'struct Internal { public var x = 1 }',
        'public protocol Storage {',
        '    func get() async throws -> String?',
        '    var name: String { get }',
        '}',
        'public enum Outcome {',
        '    /// Closed.',
        '    case dismissed',
        '    static func hidden() {}',
        '}',
        'extension Client {',
        '    public var later: Int { 1 }',
        '    func alsoHidden() {}',
        '}',
        '',
      ].join('\n'),
      'swift',
      'Sample.swift'
    )
    expect(found.map((entry) => entry.name)).toEqual([
      'Client',
      'Client.signOut',
      'Client.state',
      'Storage',
      'Storage.get',
      'Storage.name',
      'Outcome',
      'Outcome.dismissed',
      'Client.later',
    ])
    expect(found[0]).toMatchObject({
      kind: 'class',
      nesting: 0,
      documentation: 'A client.\n\nMore.',
      code: 'public final class Client: Sendable',
    })
    expect(found[1]?.code).toBe(
      '@discardableResult\npublic func signOut(\n    everywhere: Bool = false\n) async throws -> Bool'
    )
    expect(found[5]?.code).toBe('var name: String { get }')
    expect(found[7]?.documentation).toBe('Closed.')
  })

  test('Kotlin: what is not private or internal is listed, and a companion is its class', () => {
    const found = nativeDeclarations(
      [
        '/**',
        ' * A client.',
        ' *',
        ' * @param key The key.',
        ' */',
        'class Client(',
        '    val key: String,',
        '    private val onDone: () -> Unit = {},',
        ') : AutoCloseable {',
        '    /** Signs out. */',
        '    suspend fun signOut(): Boolean = true',
        '    private fun hidden() {}',
        '    internal val alsoHidden = 1',
        '    override fun close() {}',
        '    companion object {',
        '        const val TIMEOUT_MS: Long = 8_000',
        '    }',
        '    private companion object Secret { val inside = 1 }',
        '}',
        'internal class Hidden { fun nothing() {} }',
        'enum class Screen {',
        '    /** No form. */',
        '    NOT_SUPPORTED,',
        '    COMPLETE;',
        '    fun last(): Boolean = this == COMPLETE',
        '}',
        '@Composable',
        'fun Screens(client: Client, onSignedIn: () -> Unit = {}) {',
        '    val local = 1',
        '}',
        '',
      ].join('\n'),
      'kotlin',
      'Sample.kt'
    )
    expect(found.map((entry) => entry.name)).toEqual([
      'Client',
      'Client.signOut',
      'Client.TIMEOUT_MS',
      'Screen',
      'Screen.NOT_SUPPORTED',
      'Screen.COMPLETE',
      'Screen.last',
      'Screens',
    ])
    expect(found[0]?.documentation).toBe('A client.\n\n@param key The key.')
    expect(found[0]?.code).toBe(
      'class Client(\n    val key: String,\n    private val onDone: () -> Unit = {},\n) : AutoCloseable'
    )
    expect(found[2]?.code).toBe('const val TIMEOUT_MS: Long = 8_000')
    expect(found[4]?.documentation).toBe('No form.')
    expect(found[7]?.code).toBe(
      '@Composable\nfun Screens(client: Client, onSignedIn: () -> Unit = {})'
    )
  })

  test('a file the scan loses its place in stops the generation, by name', () => {
    expect(() => names('public struct A {\n', 'swift')).toThrow(/lost the place in Sample/)
    expect(() => names('class A {\n}\n}\n', 'kotlin')).toThrow(/lost the place in Sample/)
  })

  // Block comments nest in both languages, and a sample in a doc comment may hold one:
  // read as the comment's end, it cut the page off inside the sample's code fence.
  test('a block comment inside a doc comment does not end it', () => {
    const fence = '`'.repeat(3)
    for (const language of ['swift', 'kotlin'] as const) {
      const declaration = language === 'swift' ? 'public func signIn() {}' : 'fun signIn() {}'
      const text = [
        '/**',
        ' * Signs in.',
        ` * ${fence}`,
        ' * call(onDone = { /* navigate */ })',
        ` * ${fence}`,
        ' * After the sample. /* one */ /* two */',
        ' */',
        declaration,
        '',
      ].join('\n')
      const [found] = nativeDeclarations(text, language, 'Sample')
      expect(found?.name).toBe('signIn')
      expect(found?.documentation).toBe(
        [
          'Signs in.',
          fence,
          'call(onDone = { /* navigate */ })',
          fence,
          'After the sample. /* one */ /* two */',
        ].join('\n')
      )
    }
  })

  // A doc comment reaches the page as Markdown: a fence it opens and never closes would
  // swallow the declaration's own code block and everything after it.
  test('a doc comment with a code fence it does not close stops the generation, by file and declaration and never by its text', () => {
    const fence = '`'.repeat(3)
    const swift = `/// Signs in.\n/// ${fence}swift\n/// canary-text()\npublic func signIn() {}\n`
    const kotlin = `/**\n * Signs in.\n * ${fence}\n * canary-text()\n */\nfun signIn() {}\n`
    for (const [text, language] of [
      [swift, 'swift'],
      [kotlin, 'kotlin'],
    ] as const) {
      let message = ''
      try {
        names(text, language)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toMatch(/code fence that is not closed/)
      expect(message).toContain('Sample')
      expect(message).toContain('signIn')
      expect(message).not.toContain('canary-text')
    }
    const closed = `/// Signs in.\n/// ${fence}swift\n/// call()\n/// ${fence}\npublic func signIn() {}\n`
    expect(names(closed, 'swift')).toEqual(['signIn'])
  })
})

describe('the native guides', () => {
  // What a native guide shows is compiled by the build of the SDK or the example it is taken
  // from: the Swift package's test targets, the Kotlin client's test sources, the Compose
  // example's UI test sources, the Expo example's sources. A sample typed into the page is not.
  const GUIDES = ['docs/swift.md', 'docs/kotlin.md', 'docs/expo.md']
  const COMPILED = [
    'native/swift/Tests/',
    'native/android/tula-auth/src/test/',
    'examples/compose/src/',
    'examples/swiftui/',
    'examples/expo/app/',
    // The example's other root, compiled by the same `tsc -p examples/expo` as `app/`.
    'examples/expo/screens/',
  ]

  test('every Swift, Kotlin and TypeScript sample is a region of a source a build compiles', () => {
    const problems: string[] = []
    let samples = 0
    for (const guide of GUIDES) {
      const lines = readFileSync(join(root, guide), 'utf8').split('\n')
      lines.forEach((line, index) => {
        const language = /^```(\w+)/.exec(line)?.[1]
        if (!language || !['swift', 'kotlin', 'ts', 'tsx', 'typescript'].includes(language)) {
          return
        }
        samples += 1
        const source = /^<!-- snippet: (\S+?)(?:#[\w-]+)? -->$/.exec(lines[index - 1] ?? '')?.[1]
        if (!source) {
          problems.push(`${guide}:${index + 1} is typed into the page`)
        } else if (!COMPILED.some((prefix) => source.startsWith(prefix))) {
          problems.push(`${guide}:${index + 1} is taken from ${source}, which no build compiles`)
        }
      })
    }
    expect(problems).toEqual([])
    expect(samples).toBeGreaterThan(40)
  })

  test('every native sample of a method page is taken from a compiled source too', () => {
    const problems: string[] = []
    const methods = join(root, 'docs/methods')
    for (const name of readdirSync(methods).filter((file) => file.endsWith('.md'))) {
      const lines = readFileSync(join(methods, name), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!/^```(swift|kotlin)\b/.test(line)) {
          return
        }
        const source = /^<!-- snippet: (\S+?)(?:#[\w-]+)? -->$/.exec(lines[index - 1] ?? '')?.[1]
        if (!source || !COMPILED.some((prefix) => source.startsWith(prefix))) {
          problems.push(`docs/methods/${name}:${index + 1}`)
        }
      })
    }
    expect(problems).toEqual([])
  })
})

describe('--tula-repo is a checkout whose build scripts run', () => {
  // Gradle runs the checkout's settings, modules and wrapper, and Xcode evaluates its
  // `Package.swift`, on the developer's machine. Every place that tells someone to pass the
  // option says so, in the same words.
  const SENTENCE =
    '`--tula-repo` must be a checkout you trust: building the project runs its build scripts.'
  const PLACES = [
    'docs/quickstart.md',
    'docs/cli.md',
    'packages/create-tula/README.md',
    'packages/create-tula/templates/swiftui/overlay/README.md.tmpl',
    'packages/create-tula/templates/compose/overlay/README.md.tmpl',
  ]

  test.each(PLACES)('%s says so', (place) => {
    const text = readFileSync(join(root, place), 'utf8').replace(/\s+/g, ' ')
    expect(text.includes(SENTENCE)).toBe(true)
  })
})

describe('commands that fetch a package by name', () => {
  // An unscoped npm package named `tula` exists and is not ours. `bunx tula …` and
  // `npx tula …` run the project's own `tula` (the bin of `@tula-tech/cli`) where that is
  // installed, and where it is not they download and run that other package, with whatever
  // is in the environment (for `tula mcp`, a secret key). So a bare sample is only ever
  // shown after the install it depends on, and a command an editor runs outside a project
  // names the package: `bunx --package @tula-tech/cli@latest tula …`.

  /** History and plans: they record what was planned and run, and are not instructions. */
  const RECORDS = ['docs/adr/', 'docs/plans/', 'docs/reference/', 'docs/business-plan.md']

  /** The markdown a reader follows, the templates a scaffolded project gets, and what the scaffolder prints. */
  function instructionFiles(): string[] {
    const files = markdownFiles()
      .map((file) => relative(root, file))
      .filter((file) => !RECORDS.some((record) => file.startsWith(record)))
      .filter((file) => !file.startsWith('.claude/'))
    const templates = join(root, 'packages/create-tula/templates')
    function walk(directory: string): void {
      for (const name of readdirSync(directory).sort()) {
        const full = join(directory, name)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (name.endsWith('.md.tmpl') || name.endsWith('.md')) {
          files.push(relative(root, full))
        }
      }
    }
    walk(templates)
    files.push('packages/create-tula/src/main.ts')
    return [...new Set(files)].sort()
  }

  const BARE = /\b(?:npx|bunx|bun x)\s+(?:--bun\s+)?tula\b/
  const INSTALLS_CLI = /\bbun add\b[^\n]*@tula-tech\/cli@latest\b/
  /**
   * Files about a project made by create-tula, whose `package.json` lists `@tula-tech/cli`:
   * there `bunx tula` is the project's own, once `bun install` has run.
   */
  const SCAFFOLDED_PROJECT = (file: string) =>
    file.startsWith('packages/create-tula/') ||
    file === 'docs/quickstart.md' ||
    file === 'AGENTS.md'

  /** Why a bare sample at this line may run a stranger's package; `null` when it cannot. */
  function bareProblem(file: string, lines: string[], index: number): string | null {
    // An install vouches for the samples of its own `##` section: a reader who lands in
    // another section of a long page has not run it. A `##` line inside a code fence is a
    // comment of the sample.
    let fenced = false
    let section = 0
    lines.slice(0, index + 1).forEach((line, at) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
      } else if (!fenced && /^## /.test(line)) {
        section = at
      }
    })
    if (INSTALLS_CLI.test(lines.slice(section, index + 1).join('\n'))) {
      return null
    }
    // A project made by create-tula lists the CLI itself: one `bun install`, anywhere above.
    const before = lines.slice(0, index + 1).join('\n')
    if (SCAFFOLDED_PROJECT(file) && /\bbun install\b/.test(before)) {
      return null
    }
    return `${file}:${index + 1}: ${(lines[index] ?? '').trim().slice(0, 80)}`
  }

  test('there are samples to check, in the docs, a README, a template and the scaffolder', () => {
    const files = instructionFiles()
    for (const expected of [
      'docs/mcp.md',
      'docs/cli.md',
      'docs/quickstart.md',
      'packages/cli/README.md',
      'packages/create-tula/templates/base/README.md.tmpl',
      'packages/create-tula/src/main.ts',
    ]) {
      expect(files).toContain(expected)
    }
    expect(files.filter((file) => RECORDS.some((record) => file.startsWith(record)))).toEqual([])
  })

  test('a bare `bunx tula` or `npx tula` comes after the install of @tula-tech/cli it runs', () => {
    const problems: string[] = []
    let seen = 0
    for (const file of instructionFiles()) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!BARE.test(line)) {
          return
        }
        seen += 1
        const problem = bareProblem(file, lines, index)
        if (problem !== null) {
          problems.push(problem)
        }
      })
    }
    expect(seen).toBeGreaterThan(20)
    expect(problems).toEqual([])
  })

  test('the check itself: what it lets through and what it stops', () => {
    const at = (file: string, text: string) => {
      const lines = text.split('\n')
      return bareProblem(file, lines, lines.length - 1)
    }
    expect(at('docs/x.md', 'bunx tula mcp')).toBe('docs/x.md:1: bunx tula mcp')
    expect(at('docs/x.md', 'npx tula mcp')).not.toBeNull()
    expect(at('docs/x.md', 'bun install\nbunx tula dev')).not.toBeNull()
    expect(at('docs/x.md', 'bun add -d @tula-tech/cli\nbunx tula dev')).not.toBeNull()
    expect(
      at('docs/x.md', 'bunx tula dev\nbun add -d @tula-tech/cli@latest\nbunx tula dev')
    ).toBeNull()
    expect(at('docs/x.md', 'bun add -d @tula-tech/cli@latest\nbunx tula dev')).toBeNull()
    // An install licenses the samples of its own section, not of one far below it.
    const far = [
      '# Page',
      '## Install',
      'bun add -d @tula-tech/cli@latest',
      'bunx tula diff',
      ...Array.from({ length: 800 }, () => 'text'),
      '## In CI',
      '### A workflow',
      'bunx tula apply',
    ]
    expect(bareProblem('docs/x.md', far, 3)).toBeNull()
    expect(bareProblem('docs/x.md', far, far.length - 1)).toBe(
      `docs/x.md:${far.length}: bunx tula apply`
    )
    // A deeper heading does not start a new section, and the page's title is no section.
    expect(
      at('docs/x.md', '## A\nbun add -d @tula-tech/cli@latest\n### B\nbunx tula dev')
    ).toBeNull()
    expect(at('docs/x.md', 'bun add -d @tula-tech/cli@latest\n## A\nbunx tula dev')).not.toBeNull()
    // A `##` inside a code fence is a comment of the sample, not a heading.
    expect(
      at('docs/x.md', '## A\n```sh\nbun add -d @tula-tech/cli@latest\n## then\nbunx tula dev\n```')
    ).toBeNull()
    expect(at('docs/quickstart.md', 'bun install\nbunx tula dev')).toBeNull()
    // Before the install, not after it: the line is judged by what stands above it.
    expect(bareProblem('docs/quickstart.md', ['bunx tula dev', 'bun install'], 0)).not.toBeNull()
    expect(BARE.test('bunx --package @tula-tech/cli@latest tula mcp')).toBe(false)
    expect(BARE.test('bun run tula -- mcp')).toBe(false)
    // `--no-install` runs what is installed or fails: it cannot fetch a stranger's package.
    expect(BARE.test('bunx --no-install tula apply --env prod')).toBe(false)
    expect(BARE.test('bunx --bun tula mcp')).toBe(true)
  })

  test('every scaffolded project lists @tula-tech/cli, and no script of it fetches a command', () => {
    const templates = join(root, 'packages/create-tula/templates')
    const frameworks = readdirSync(templates).filter((name) => name !== 'base')
    expect(frameworks.sort()).toEqual(['compose', 'expo', 'nextjs', 'react-vite', 'swiftui'])
    for (const framework of frameworks) {
      const manifest = JSON.parse(
        readFileSync(join(templates, framework, 'package.json'), 'utf8')
      ) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> }
      expect({
        framework,
        cli: Object.hasOwn(manifest.devDependencies ?? {}, '@tula-tech/cli'),
      }).toEqual({ framework, cli: true })
      for (const script of Object.values(manifest.scripts ?? {})) {
        expect(script).not.toMatch(/\b(?:npx|bunx|bun x)\b/)
      }
    }
  })

  // A command an editor or an assistant starts runs wherever that program was started, not
  // in a project with the CLI installed: it names the package, always.
  // `bun run <script> --otp 123456` is echoed by Bun itself ("$ … --otp "123456"") before
  // the script starts, where nothing of the script can strike it out. `--silent` stops that.
  test('the runbook hands over a one-time password without Bun echoing it', () => {
    const doc = readFileSync(join(root, 'docs/releasing.md'), 'utf8')
    const samples = doc.split('\n').filter((line) => /--otp\s+\d/.test(line))
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(sample.trim()).toMatch(/^bun run --silent release:publish --otp \d{6}\b/)
    }
    expect(doc).not.toMatch(/bun run release:publish --otp/)
    const said = doc.replace(/\s+/g, ' ')
    expect(said).toContain('`bun run` prints the command it starts')
    expect(said).not.toMatch(/and never printed|never printed and never stored/)
    const rule = readFileSync(join(root, '.claude/rules/publishable-packages.md'), 'utf8').replace(
      /\s+/g,
      ' '
    )
    expect(rule).toContain('bun run --silent release:publish --otp <code>')
    expect(rule).not.toContain('printed nowhere')
  })

  test('a command an MCP client runs names the package', () => {
    const problems: string[] = []
    let configs = 0
    for (const file of instructionFiles()) {
      const text = readFileSync(join(root, file), 'utf8')
      for (const match of text.matchAll(/"command":\s*"([^"]*)",\s*"args":\s*\[([^\]]*)\]/g)) {
        if (!/"tula"/.test(match[2] ?? '')) {
          continue
        }
        configs += 1
        if (
          match[1] !== 'bunx' ||
          !(match[2] ?? '').startsWith('"--package", "@tula-tech/cli@latest", "tula", "mcp"')
        ) {
          problems.push(`${file}: ${match[0].replace(/\s+/g, ' ')}`)
        }
      }
      text.split('\n').forEach((line, index) => {
        if (/^\s*--\s+\S/.test(line) && /\btula\b/.test(line)) {
          configs += 1
          if (!/--\s+bunx --package @tula-tech\/cli@latest tula mcp\b/.test(line)) {
            problems.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        }
      })
    }
    expect(configs).toBeGreaterThanOrEqual(3)
    expect(problems).toEqual([])
    // The page about the server shows no bare form at all, and the CLI's README says why.
    expect(BARE.test(readFileSync(join(root, 'docs/mcp.md'), 'utf8'))).toBe(false)
    expect(
      readFileSync(join(root, 'packages/cli/README.md'), 'utf8').replace(/\s+/g, ' ')
    ).toContain('resolves to an unrelated package named `tula`')
  })

  // A release writes the `latest` dist-tag, and every sample names it: the `alpha` tag of the
  // first releases still exists and is never moved again, so a sample that named it would
  // install the first alpha for ever.
  const VERB =
    /\b(?:bun add|bun install|bun i|npm install|npm i|pnpm add|yarn add|bunx|npx|bun x|bun create|npm create|bun info|npm view)\b/
  const NAMED =
    /(@tula-tech\/[a-z][a-z-]*|\bcreate-tula\b|(?<=\bcreate )tula\b)(@[A-Za-z0-9.:/_-]+)?/g

  /** The package names an install line gives without the `latest` tag. */
  function untagged(line: string): string[] {
    if (!VERB.test(line)) {
      return []
    }
    const found: string[] = []
    // Each command of the line by itself: `bun run --filter create-tula …` installs nothing.
    for (const command of line.split(/&&|;|\|/)) {
      const verb = VERB.exec(command)
      if (!verb) {
        continue
      }
      for (const match of command.slice(verb.index).matchAll(NAMED)) {
        const [, name, tag] = match
        // A subpath (`@tula-tech/expo/plugin`) is an import, and a tarball is not the registry.
        const after = command.slice(verb.index)[(match.index ?? 0) + match[0].length]
        if (after === '/' || tag?.startsWith('@file:')) {
          continue
        }
        if (tag !== '@latest') {
          found.push(`${name}${tag ?? ''}`)
        }
      }
    }
    return found
  }

  test('every sample that installs or runs a Tula package from npm names the latest tag', () => {
    const problems: string[] = []
    let seen = 0
    for (const file of instructionFiles()) {
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (VERB.test(line) && /@tula-tech\/|create-tula|create tula/.test(line)) {
            seen += 1
          }
          for (const name of untagged(line)) {
            problems.push(`${file}:${index + 1}: ${name}`)
          }
        })
    }
    expect(seen).toBeGreaterThan(10)
    expect(problems).toEqual([])
  })

  test('the tag check itself', () => {
    expect(untagged('bun add @tula-tech/core')).toEqual(['@tula-tech/core'])
    expect(untagged('bun add @tula-tech/core@alpha')).toEqual(['@tula-tech/core@alpha'])
    expect(untagged('bun add @tula-tech/core@latest @tula-tech/react')).toEqual([
      '@tula-tech/react',
    ])
    expect(untagged('bun add -d @tula-tech/cli@latest      # then: bunx tula <command>')).toEqual(
      []
    )
    expect(untagged('bun create tula my-app')).toEqual(['tula'])
    expect(untagged('bun create tula@latest my-app')).toEqual([])
    expect(untagged('bunx create-tula my-app --framework nextjs')).toEqual(['create-tula'])
    expect(untagged('bunx create-tula@latest my-app && cd my-app && bun install')).toEqual([])
    expect(untagged('bunx --package @tula-tech/cli tula mcp')).toEqual(['@tula-tech/cli'])
    expect(untagged('bunx --package @tula-tech/cli@latest tula mcp')).toEqual([])
    expect(untagged('bun add @tula-tech/expo@file:../.release/tula-tech-expo-0.0.0.tgz')).toEqual(
      []
    )
    expect(untagged('bun run --filter create-tula templates:sync')).toEqual([])
    expect(untagged('bun run --filter @tula-tech/react generate')).toEqual([])
    expect(untagged("plugins: ['@tula-tech/expo/plugin'] # bunx expo prebuild")).toEqual([])
    expect(untagged('import { x } from "@tula-tech/core"')).toEqual([])
  })
})
