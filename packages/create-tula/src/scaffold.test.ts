import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { templateDrift } from '../scripts/sync-templates'
import { FRAMEWORKS, main, processIo, scaffold, VERSION, validateProjectName } from './index'
import { findTemplates, ScaffoldError } from './scaffold'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'create-tula-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tree(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
      } else {
        found.push(relative(root, child))
      }
    }
  }
  await walk(root)
  return found.sort()
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function run(args: string[], io: Partial<Parameters<typeof main>[1]> = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd: dir,
    isTTY: false,
    ...io,
  })
  return { code, stdout, stderr }
}

describe('validateProjectName', () => {
  test.each(['shop', 'my-app', 'app_2', 'a', '0day'])('accepts %s', (name) => {
    expect(validateProjectName(name)).toBeNull()
  })

  test.each([
    ['', 'empty'],
    ['../evil', 'a path'],
    ['a/b', 'a path'],
    ['a\\b', 'a path'],
    ['..', 'a path'],
    ['.hidden', 'a leading dot'],
    ['My-App', 'upper case'],
    ['my app', 'a space'],
    ['-app', 'a leading dash'],
    ['_app', 'a leading underscore'],
    ['node_modules', 'a reserved name'],
    ['a'.repeat(64), 'too long'],
    ['app\u0000', 'a control character'],
    ['@scope/app', 'a scope'],
  ])('refuses %j (%s) with a reason', (name) => {
    expect(validateProjectName(name)).toEqual(expect.any(String))
  })
})

describe('scaffold', () => {
  test('react-vite: the project’s files, exactly', async () => {
    const result = await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    expect(result.directory).toBe(join(dir, 'shop'))
    expect(await tree(join(dir, 'shop'))).toEqual([
      '.env',
      '.env.example',
      '.gitignore',
      'README.md',
      'compose.yaml',
      'docker/postgres/init.sh',
      'index.html',
      'package.json',
      'src/app.css',
      'src/app.tsx',
      'src/auth-provider.tsx',
      'src/main.tsx',
      'src/protected.tsx',
      'src/sign-in-page.tsx',
      'tsconfig.json',
      'tula.config.ts',
      'vite.config.ts',
    ])
  })

  test('nextjs: the app router files and its own config', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'nextjs' })
    const files = await tree(join(dir, 'shop'))
    for (const file of [
      'app/layout.tsx',
      'app/api/tula/[...tula]/route.ts',
      'proxy.ts',
      'next.config.ts',
      'tsconfig.json',
      'compose.yaml',
      '.env',
    ]) {
      expect(files).toContain(file)
    }
    const config = await readFile(join(dir, 'shop', 'next.config.ts'), 'utf8')
    // The repository's own config compiles the workspace; an installed app needs none of it.
    expect(config).not.toContain('transpilePackages')
  })

  test('.env: fresh secrets, owner-readable only, and no placeholder left anywhere', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    const root = join(dir, 'shop')
    const env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
    expect(env.COMPOSE_PROJECT_NAME).toBe('shop')
    expect(env.TULA_MASTER_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(env.TULA_ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(env.TULA_API_DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(env.TULA_API_IMAGE).toBe('tula-api:local')
    expect(env.API_PORT).toBe('3003')
    const secrets = [
      env.TULA_MASTER_KEY,
      env.TULA_ADMIN_TOKEN,
      env.POSTGRES_PASSWORD,
      env.TULA_API_DB_PASSWORD,
    ]
    expect(new Set(secrets).size).toBe(4)
    if (process.platform !== 'win32') {
      expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, 'docker/postgres/init.sh'))).mode & 0o111).not.toBe(0)
    }
    // No secret is in any file that git tracks, and no `{{…}}` survived in a templated file.
    for (const file of (await tree(root)).filter((path) => path !== '.env')) {
      const text = await readFile(join(root, file), 'utf8')
      for (const secret of secrets) {
        expect(text).not.toContain(secret as string)
      }
      if (!file.startsWith('src/') && !file.startsWith('app/')) {
        expect(text).not.toMatch(/\{\{\w+\}\}/)
      }
    }
  })

  test('two projects never share a secret', async () => {
    await scaffold({ cwd: dir, name: 'one', framework: 'react-vite' })
    await scaffold({ cwd: dir, name: 'two', framework: 'react-vite' })
    const one = parseEnv(await readFile(join(dir, 'one', '.env'), 'utf8'))
    const two = parseEnv(await readFile(join(dir, 'two', '.env'), 'utf8'))
    for (const name of [
      'TULA_MASTER_KEY',
      'TULA_ADMIN_TOKEN',
      'POSTGRES_PASSWORD',
      'TULA_API_DB_PASSWORD',
    ]) {
      expect(one[name]).not.toBe(two[name])
    }
  })

  test('.gitignore covers .env and .env.local, and keeps .env.example', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    const lines = (await readFile(join(dir, 'shop', '.gitignore'), 'utf8')).split('\n')
    expect(lines).toContain('.env')
    expect(lines).toContain('.env.*')
    expect(lines).toContain('!.env.example')
    expect(lines).toContain('node_modules/')
    const example = await readFile(join(dir, 'shop', '.env.example'), 'utf8')
    expect(parseEnv(example).TULA_MASTER_KEY).toBe('')
  })

  test('package.json: the project’s name, Tula packages pinned to this release', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    const manifest = JSON.parse(await readFile(join(dir, 'shop', 'package.json'), 'utf8'))
    expect(manifest.name).toBe('shop')
    expect(manifest.dependencies['@tula/react']).toBe(VERSION)
    expect(manifest.devDependencies['@tula/cli']).toBe(VERSION)
    expect(manifest.devDependencies['@tula/config']).toBe(VERSION)
    expect(manifest.dependencies.react).toMatch(/^\^/)
    expect(manifest.overrides).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
    expect(JSON.stringify(manifest)).not.toContain('"*"')
  })

  test('local tarballs: every Tula package, direct or transitive, comes from the directory', async () => {
    const tarballs = join(dir, 'release')
    await mkdir(tarballs)
    for (const name of ['react', 'core', 'contract', 'cli', 'config', 'admin', 'nextjs', 'mcp']) {
      await writeFile(join(tarballs, `tula-${name}-${VERSION}.tgz`), '')
    }
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', tulaPackages: tarballs })
    const manifest = JSON.parse(await readFile(join(dir, 'shop', 'package.json'), 'utf8'))
    const spec = (name: string) => `file:${join(tarballs, `tula-${name}-${VERSION}.tgz`)}`
    expect(manifest.dependencies['@tula/react']).toBe(spec('react'))
    expect(manifest.devDependencies['@tula/cli']).toBe(spec('cli'))
    expect(manifest.overrides['@tula/core']).toBe(spec('core'))
    expect(manifest.overrides['@tula/contract']).toBe(spec('contract'))
  })

  test('local tarballs: a missing one is an error that names it', async () => {
    const tarballs = join(dir, 'release')
    await mkdir(tarballs)
    await expect(
      scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', tulaPackages: tarballs })
    ).rejects.toThrow('tula-')
    expect(await tree(dir)).toEqual([])
  })

  test('the config names the project and the README says how to start', async () => {
    await scaffold({
      cwd: dir,
      name: 'my-shop',
      framework: 'nextjs',
      apiPort: 53003,
      mailpitPort: 58025,
    })
    const root = join(dir, 'my-shop')
    expect(await readFile(join(root, 'tula.config.ts'), 'utf8')).toContain("name: 'my-shop'")
    const readme = await readFile(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('bunx tula dev')
    expect(readme).toContain('53003')
    expect(readme).toContain('Next.js')
    const env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
    expect(env.API_PORT).toBe('53003')
    expect(env.MAILPIT_UI_PORT).toBe('58025')
  })

  test('refuses a directory that has anything in it, and writes nothing', async () => {
    await mkdir(join(dir, 'shop'))
    await writeFile(join(dir, 'shop', 'notes.txt'), 'mine')
    await expect(scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })).rejects.toThrow(
      'not empty'
    )
    expect(await tree(join(dir, 'shop'))).toEqual(['notes.txt'])
  })

  test('an empty directory is fine', async () => {
    await mkdir(join(dir, 'shop'))
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    expect(await tree(join(dir, 'shop'))).toContain('compose.yaml')
  })

  test('--force writes into a directory with files, and never replaces .env or .env.local', async () => {
    const root = join(dir, 'shop')
    await mkdir(root)
    await writeFile(join(root, '.env'), 'TULA_MASTER_KEY=the-one-my-data-is-sealed-with\n')
    await writeFile(join(root, '.env.local'), 'TULA_SECRET_KEY=mine\n')
    await writeFile(join(root, 'README.md'), 'old')
    const result = await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', force: true })
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(
      'TULA_MASTER_KEY=the-one-my-data-is-sealed-with\n'
    )
    expect(await readFile(join(root, '.env.local'), 'utf8')).toBe('TULA_SECRET_KEY=mine\n')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toContain('bunx tula dev')
    expect(result.keptEnv).toBe(true)
  })

  // A crash or Ctrl-C between two writes must never leave the secrets on disk without the
  // file that keeps them out of git.
  test('.gitignore is written first and .env last', async () => {
    const { files } = await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite' })
    expect(files[0]).toBe('.gitignore')
    expect(files.at(-1)).toBe('.env')
    expect(files).toContain('compose.yaml')
  })

  test('--force keeps an existing .gitignore and adds the lines it lacks, once', async () => {
    const root = join(dir, 'shop')
    await mkdir(root)
    const mine = '# mine\ncoverage/\n.env\n/private-notes'
    await writeFile(join(root, '.gitignore'), mine)
    const options = { cwd: dir, name: 'shop', framework: 'react-vite', force: true } as const
    const first = await scaffold(options)
    expect(first.files).toContain('.gitignore')
    const text = await readFile(join(root, '.gitignore'), 'utf8')
    expect(text.startsWith(`${mine}\n`)).toBe(true)
    const lines = text.split('\n')
    for (const line of ['.env', '.env.*', '!.env.example', 'node_modules/', 'coverage/']) {
      expect(lines.filter((candidate) => candidate === line)).toHaveLength(1)
    }
    // The exception has to come after the pattern it is an exception to.
    expect(lines.indexOf('!.env.example')).toBeGreaterThan(lines.indexOf('.env.*'))

    const second = await scaffold(options)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(text)
    expect(second.files).not.toContain('.gitignore')
  })

  test('an exception the user wrote above is repeated after the pattern that would undo it', async () => {
    const root = join(dir, 'shop')
    await mkdir(root)
    await writeFile(join(root, '.gitignore'), '!.env.example\n')
    await scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', force: true })
    const lines = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n')
    expect(lines.lastIndexOf('!.env.example')).toBeGreaterThan(lines.indexOf('.env.*'))
  })

  test.each([
    ['.env', '.env'],
    ['.gitignore', '.gitignore'],
    ['a file of the app', 'package.json'],
  ])('a dangling symlink at %s is refused and nothing is written through it', async (_, path) => {
    const root = join(dir, 'shop')
    const outside = join(dir, 'outside')
    await mkdir(root)
    await symlink(outside, join(root, path))
    const attempt = scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', force: true })
    await expect(attempt).rejects.toThrow(ScaffoldError)
    await expect(attempt).rejects.toThrow('symbolic link')
    expect(await tree(dir)).toEqual([join('shop', path)])
    expect((await lstat(join(root, path))).isSymbolicLink()).toBe(true)
  })

  test('a symlinked directory inside the project, or the project itself, is refused', async () => {
    const outside = join(dir, 'outside')
    await mkdir(outside)
    const root = join(dir, 'shop')
    await mkdir(root)
    await symlink(outside, join(root, 'src'))
    await expect(
      scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', force: true })
    ).rejects.toThrow(ScaffoldError)
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(root)).toEqual(['src'])

    // An empty directory elsewhere, reached through a link named like the project.
    await symlink(outside, join(dir, 'linked'))
    await expect(scaffold({ cwd: dir, name: 'linked', framework: 'react-vite' })).rejects.toThrow(
      ScaffoldError
    )
    expect(await readdir(outside)).toEqual([])
  })

  test('a name that is not safe is refused before anything is written', async () => {
    await expect(scaffold({ cwd: dir, name: '../evil', framework: 'react-vite' })).rejects.toThrow()
    expect(await tree(dir)).toEqual([])
  })

  test.each([
    ['apiImage', { apiImage: 'bad image; echo injected' }],
    ['apiPort', { apiPort: 70_000 }],
    ['mailpitPort', { mailpitPort: 0 }],
  ])('an unusable %s is refused', async (_name, options) => {
    await expect(
      scaffold({ cwd: dir, name: 'shop', framework: 'react-vite', ...options })
    ).rejects.toThrow()
    expect(await tree(dir)).toEqual([])
  })

  test('the mock OAuth provider can be switched on from .env, and is off until then', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'nextjs' })
    const root = join(dir, 'shop')
    // Trying "Continue with Google" before there are real credentials is configuration, not
    // an edit of the Compose file: the API reads the switch from the project's `.env`.
    expect(await readFile(join(root, 'compose.yaml'), 'utf8')).toMatch(
      /^ {6}OAUTH_MOCK_PROVIDER: \$\{OAUTH_MOCK_PROVIDER:-false\}$/m
    )
    // It signs in anyone as any address: never on in a new project.
    expect(await readFile(join(root, '.env'), 'utf8')).not.toMatch(/^OAUTH_MOCK_PROVIDER=/m)
    expect(await readFile(join(root, '.env.example'), 'utf8')).toContain(
      '# OAUTH_MOCK_PROVIDER=true'
    )
  })

  test('text messages are configured from .env: no sender and no Twilio value until then', async () => {
    await scaffold({ cwd: dir, name: 'shop', framework: 'nextjs' })
    const root = join(dir, 'shop')
    const compose = await readFile(join(root, 'compose.yaml'), 'utf8')
    expect(compose).toMatch(/^ {6}SMS_PROVIDER: \$\{SMS_PROVIDER:-none\}$/m)
    // Every Twilio variable is passed through from .env and has no value of its own: a
    // scaffold never ships a credential, a default one least of all.
    const names = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_MESSAGING_SERVICE_SID',
      'TWILIO_FROM_NUMBER',
    ]
    for (const name of names) {
      expect(compose).toContain(`      ${name}: \${${name}:-}\n`)
    }
    expect([...compose.matchAll(/^ {6}(TWILIO_[A-Z_]+):/gm)].map((match) => match[1])).toEqual(
      names
    )
    const env = await readFile(join(root, '.env'), 'utf8')
    expect(env).not.toMatch(/^(SMS_PROVIDER|TWILIO_[A-Z_]+)=/m)
    const example = await readFile(join(root, '.env.example'), 'utf8')
    for (const name of names) {
      expect(example).toContain(`# ${name}=\n`)
    }
  })

  test('the pinned service images are the repository’s own', async () => {
    const repo = await readFile(join(import.meta.dir, '../../../docker-compose.yml'), 'utf8')
    const template = await readFile(join(import.meta.dir, '../templates/base/compose.yaml'), 'utf8')
    const pinned = (text: string): string[] =>
      [...(text.match(/image: \S+@sha256:[0-9a-f]{64}/g) ?? [])].sort()
    // The repository's stack also has the proxy in front of its two API instances (`lb`); a
    // new project runs one instance and has none.
    const shared = [...new Set(pinned(repo))].filter((image) => !image.startsWith('image: nginx:'))
    expect(pinned(repo).filter((image) => image.startsWith('image: nginx:'))).toHaveLength(1)
    expect(pinned(template)).toEqual(shared.sort())
    expect(pinned(template)).toHaveLength(3)
  })
})

describe('findTemplates', () => {
  // The published build puts this code in a chunk below `dist/`, not beside `templates/` as
  // the sources are: found by installing the packed tarball.
  test('finds the templates from the source layout and from a chunk inside dist', async () => {
    const root = join(dir, 'package')
    await mkdir(join(root, 'templates', 'base'), { recursive: true })
    await writeFile(join(root, 'templates', 'base', 'compose.yaml'), '')
    await mkdir(join(root, 'dist', 'shared'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    for (const from of ['src', 'dist', join('dist', 'shared')]) {
      expect(findTemplates(join(root, from))).toBe(join(root, 'templates'))
    }
  })

  test('says so when the package has no templates', () => {
    expect(() => findTemplates(dir)).toThrow('templates')
  })
})

describe('the templates', () => {
  test('are in step with the example apps (run `bun run --filter create-tula templates:sync`)', async () => {
    expect(await templateDrift()).toEqual([])
  })

  test('there is one per framework', () => {
    expect(FRAMEWORKS).toEqual(['react-vite', 'nextjs'])
  })
})

describe('create-tula (the command)', () => {
  test('scaffolds from flags and says what to do next, without printing a secret', async () => {
    const result = await run(['shop', '--framework', 'react-vite'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('cd shop')
    expect(result.stdout).toContain('bunx tula dev')
    const env = parseEnv(await readFile(join(dir, 'shop', '.env'), 'utf8'))
    expect(result.stdout + result.stderr).not.toContain(env.TULA_MASTER_KEY as string)
    expect(result.stdout + result.stderr).not.toContain(env.TULA_ADMIN_TOKEN as string)
  })

  test('asks for the name and the framework on a terminal', async () => {
    const answers = ['shop', '2']
    const questions: string[] = []
    const result = await run([], {
      isTTY: true,
      prompt: async (question: string) => {
        questions.push(question)
        return answers.shift() ?? ''
      },
    })
    expect(result.code).toBe(0)
    expect(questions).toHaveLength(2)
    expect(await tree(join(dir, 'shop'))).toContain('next.config.ts')
  })

  test('without a terminal, a missing name or framework is an error, not a guess', async () => {
    expect((await run([])).code).toBe(1)
    const noFramework = await run(['shop'])
    expect(noFramework.code).toBe(1)
    expect(noFramework.stderr).toContain('--framework')
    expect(await tree(dir)).toEqual([])
  })

  test.each([
    [['shop', '--framework', 'svelte'], 'react-vite'],
    [['../x', '--framework', 'nextjs'], 'name'],
    [['shop', '--framework', 'nextjs', '--api-port', 'abc'], '--api-port'],
    [['shop', '--nope'], 'Unknown option'],
    [['a', 'b', '--framework', 'nextjs'], 'one'],
    [['shop', '--framework'], 'needs a value'],
  ])('%j is refused with a message', async (args, text) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(text)
    expect(await tree(dir)).toEqual([])
  })

  test('an answer that is not a framework is refused; an empty one takes the first', async () => {
    const wrong = await run(['shop'], { isTTY: true, prompt: async () => 'svelte' })
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('react-vite')
    const first = await run(['shop'], { isTTY: true, prompt: async () => '' })
    expect(first.code).toBe(0)
    expect(await tree(join(dir, 'shop'))).toContain('vite.config.ts')
  })

  test('--name=value form, and a failure nobody foresaw is reported without a stack', async () => {
    const result = await run(['shop', '--framework=nextjs', '--api-port=53003'])
    expect(result.code).toBe(0)
    const broken = await run(['other', '--framework', 'nextjs'], {
      cwd: join(dir, 'shop', 'package.json'),
    })
    expect(broken.code).toBe(1)
    expect(broken.stderr).toMatch(/^error: /)
    expect(broken.stderr).not.toContain('    at ')
  })

  test('the real surroundings: the process’s own by default, and a prompt on standard error', async () => {
    expect(processIo().cwd).toBe(process.cwd())
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stderr = Object.assign(new PassThrough(), { isTTY: true })
    let asked = ''
    stderr.on('data', (chunk) => {
      asked += String(chunk)
    })
    const io = processIo({ stdin, stdout: new PassThrough(), stderr, cwd: () => '/work' })
    expect(io).toMatchObject({ cwd: '/work', isTTY: true })
    const answer = io.prompt?.('Project name: ')
    stdin.write('shop\n')
    expect(await answer).toBe('shop')
    expect(asked).toContain('Project name: ')
  })

  test('--help and --version', async () => {
    expect((await run(['--help'])).stdout).toContain('Usage: create-tula')
    expect((await run(['--version'])).stdout).toBe(`${VERSION}\n`)
  })

  test('the version is the package’s', async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'))
    expect(VERSION).toBe(manifest.version)
  })

  test('the executable runs', () => {
    const child = Bun.spawnSync(['bun', join(import.meta.dir, 'bin.ts'), '--version'], {
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(`${VERSION}\n`)
  })
})
