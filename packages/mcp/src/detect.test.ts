import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFramework } from './detect'
import { callTool, connect } from './testing/fake-api'

let base: string
let root: string
let outside: string

const manifest = (dependencies: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: 'app', dependencies, devDependencies: dev, scripts: { secret: 'SHH' } })

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'tula-mcp-detect-')))
  root = join(base, 'project')
  outside = join(base, 'elsewhere')
  await mkdir(join(root, 'apps', 'web'), { recursive: true })
  await mkdir(join(root, 'apps', 'spa'), { recursive: true })
  await mkdir(join(root, 'apps', 'api'), { recursive: true })
  await mkdir(join(root, 'apps', 'empty'), { recursive: true })
  await mkdir(join(root, 'apps', 'broken'), { recursive: true })
  await mkdir(join(root, 'apps', 'linked-manifest'), { recursive: true })
  await mkdir(join(root, 'apps', 'dir-manifest', 'package.json'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'package.json'), manifest({}, { turbo: '2' }))
  await writeFile(
    join(root, 'apps', 'web', 'package.json'),
    manifest({ next: '16', react: '19', '@tula/nextjs': '*', '@tula/react': '*' })
  )
  await writeFile(
    join(root, 'apps', 'spa', 'package.json'),
    manifest({ react: '19' }, { vite: '7', '@tula/cli': '*' })
  )
  await writeFile(join(root, 'apps', 'api', 'package.json'), manifest({ hono: '4' }))
  await writeFile(join(root, 'apps', 'broken', 'package.json'), '{ not json')
  await writeFile(join(outside, 'package.json'), manifest({ next: '16' }))
  await symlink(outside, join(root, 'apps', 'escape'))
  await symlink(
    join(outside, 'package.json'),
    join(root, 'apps', 'linked-manifest', 'package.json')
  )
  await symlink(join(root, 'apps', 'web'), join(root, 'apps', 'alias'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('detect_framework', () => {
  test.each([
    ['.', 'unknown', '.', []],
    ['apps/web', 'nextjs', 'apps/web', ['@tula/nextjs', '@tula/react']],
    ['./apps/web/', 'nextjs', 'apps/web', ['@tula/nextjs', '@tula/react']],
    ['apps/spa', 'react-vite', 'apps/spa', ['@tula/cli']],
    ['apps/api', 'unknown', 'apps/api', []],
    ['apps/web/../spa', 'react-vite', 'apps/spa', ['@tula/cli']],
    // A link that stays inside the root is followed and reported as where it leads.
    ['apps/alias', 'nextjs', 'apps/web', ['@tula/nextjs', '@tula/react']],
  ])('%s → %s', async (directory, framework, reported, tulaPackages) => {
    expect(await detectFramework(root, directory)).toEqual({
      directory: reported,
      framework,
      supported: framework !== 'unknown',
      tulaPackages,
    } as Awaited<ReturnType<typeof detectFramework>>)
  })

  test('an absolute path inside the root is accepted', async () => {
    expect((await detectFramework(root, join(root, 'apps', 'web'))).framework).toBe('nextjs')
  })

  test.each([
    ['a parent directory', '..'],
    ['a climb past the root', 'apps/../../elsewhere'],
    ['a deep climb', '../../../../../../etc'],
    ['an absolute path elsewhere', '/etc'],
    ['the sibling directory, absolutely', () => outside],
    ['a directory whose name starts like the root’s', () => `${root}-other`],
    ['a link that leads out of the root', 'apps/escape'],
    ['a package.json that is a link out of the root', 'apps/linked-manifest'],
    ['a NUL byte', 'apps/web\0/../..'],
  ])('%s is refused as outside the root', async (_name, directory) => {
    const path = typeof directory === 'function' ? directory() : directory
    await expect(detectFramework(root, path)).rejects.toMatchObject({ code: 'path.outside_root' })
  })

  test.each([
    ['a directory that is not there', 'apps/nope', 'path.not_found'],
    ['a directory with no package.json', 'apps/empty', 'path.not_found'],
    ['a package.json that is not JSON', 'apps/broken', 'package.invalid'],
    ['a package.json that is a directory', 'apps/dir-manifest', 'package.invalid'],
  ])('%s is %s', async (_name, directory, code) => {
    await expect(detectFramework(root, directory)).rejects.toMatchObject({ code })
  })

  test('nothing of the file is returned but the framework and the Tula packages', async () => {
    const { client, close } = await connect({ cwd: root })
    const result = await callTool(client, 'detect_framework', { directory: 'apps/web' })
    expect(result.structured).toEqual({
      directory: 'apps/web',
      framework: 'nextjs',
      supported: true,
      tulaPackages: ['@tula/nextjs', '@tula/react'],
    })
    expect(result.raw).not.toContain('SHH')
    const refused = await callTool(client, 'detect_framework', { directory: '../elsewhere' })
    expect(refused.isError).toBe(true)
    expect(refused.structured.error).toMatchObject({ code: 'path.outside_root' })
    expect(refused.raw).not.toContain(base)
    await close()
  })

  test('the default directory is the one the server was started in', async () => {
    const { client, close } = await connect({ cwd: join(root, 'apps', 'spa') })
    expect((await callTool(client, 'detect_framework')).structured.framework).toBe('react-vite')
    await close()
  })
})
