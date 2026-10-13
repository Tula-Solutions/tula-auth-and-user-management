import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { expectedModule, SCAFFOLD_SOURCES, scaffoldDrift } from '../scripts/sync-scaffolds'
import { SCAFFOLD_FRAMEWORKS } from './detect'
import { SCAFFOLD_FILES } from './scaffolds.gen'
import { callTool, connect } from './testing/fake-api'

const repo = join(import.meta.dir, '..', '..', '..')
const TOOLS = {
  scaffold_provider: 'provider',
  scaffold_protected_route: 'protectedRoute',
  scaffold_sign_in_page: 'signInPage',
} as const

/**
 * Where each framework's example lives, the one source of every scaffolded file, and the
 * directory its files have in a project (a native app's own directory; a web app is the
 * project).
 */
const EXAMPLES: Record<string, { example: string; into: string }> = {
  nextjs: { example: 'examples/nextjs-app-router', into: '' },
  'react-vite': { example: 'examples/react-vite', into: '' },
  expo: { example: 'examples/expo/app', into: 'app/' },
  swiftui: { example: 'examples/swiftui', into: 'ios/' },
  compose: { example: 'examples/compose', into: 'android/app/' },
}

describe('the scaffolds', () => {
  test('the generated module is what the templates say it should be', async () => {
    expect(await scaffoldDrift()).toBe(false)
    expect(await Bun.file(join(import.meta.dir, 'scaffolds.gen.ts')).text()).toBe(
      await expectedModule()
    )
  })

  test('every file is byte for byte the example app’s file', async () => {
    for (const framework of SCAFFOLD_FRAMEWORKS) {
      for (const files of Object.values(SCAFFOLD_FILES[framework])) {
        for (const file of files) {
          const { example, into } = EXAMPLES[framework] as { example: string; into: string }
          expect(file.path.startsWith(into)).toBe(true)
          const source = join(repo, example, file.path.slice(into.length))
          expect(file.contents).toBe(await Bun.file(source).text())
        }
      }
    }
  })

  test('every framework has all three scaffolds', () => {
    expect(Object.keys(SCAFFOLD_SOURCES).sort()).toEqual([...SCAFFOLD_FRAMEWORKS].sort())
    for (const framework of SCAFFOLD_FRAMEWORKS) {
      expect(Object.keys(SCAFFOLD_FILES[framework]).sort()).toEqual(Object.values(TOOLS).sort())
    }
  })

  test.each(
    SCAFFOLD_FRAMEWORKS.flatMap((framework) =>
      Object.keys(TOOLS).map((tool) => [tool, framework] as const)
    )
  )('%s for %s: files with their paths, the same every time', async (tool, framework) => {
    const { client, close } = await connect({ cwd: import.meta.dir })
    const first = await callTool(client, tool, { framework })
    const second = await callTool(client, tool, { framework })
    await close()
    expect(first.isError).toBe(false)
    expect(second.structured).toEqual(first.structured)
    const kind = TOOLS[tool as keyof typeof TOOLS]
    const files = first.structured.files as { path: string; contents: string }[]
    expect(files).toEqual(SCAFFOLD_FILES[framework][kind].map((file) => ({ ...file })))
    for (const file of files) {
      // A path the client can join to the project's root: relative, no climbing.
      expect(file.path.startsWith('/')).toBe(false)
      expect(file.path).not.toContain('\\')
      expect(file.path.split('/').every((part) => part !== '' && part !== '..')).toBe(true)
      expect(file.contents.length).toBeGreaterThan(50)
    }
    expect({
      framework: first.structured.framework,
      paths: files.map((file) => file.path),
      dependencies: first.structured.dependencies,
      environment: (first.structured.environment as { name: string }[]).map(
        (variable) => variable.name
      ),
      notes: (first.structured.notes as string[]).length,
    }).toMatchSnapshot()
  })

  test('the provider reads the publishable key from the environment and names no secret', async () => {
    const { client, close } = await connect({ cwd: import.meta.dir })
    const next = await callTool(client, 'scaffold_provider', { framework: 'nextjs' })
    const vite = await callTool(client, 'scaffold_provider', { framework: 'react-vite' })
    expect(next.text).toContain('process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY')
    expect(vite.text).toContain('import.meta.env.VITE_TULA_PUBLISHABLE_KEY')
    const expo = await callTool(client, 'scaffold_provider', { framework: 'expo' })
    expect(expo.text).toContain('process.env.EXPO_PUBLIC_TULA_PUBLISHABLE_KEY')
    const everything: string[] = []
    for (const tool of Object.keys(TOOLS)) {
      for (const framework of SCAFFOLD_FRAMEWORKS) {
        everything.push(JSON.stringify((await callTool(client, tool, { framework })).structured))
      }
    }
    await close()
    const all = everything.join('\n')
    // No key of either kind, no token, nothing that was redacted on the way out.
    expect(all).not.toMatch(/tula_(sk|pk)_[a-z]+_[A-Za-z0-9_-]{8,}/)
    expect(all).not.toContain('[redacted]')
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./)
    // The only mention of the secret key is the name of the variable the server reads.
    expect(all.match(/TULA_SECRET_KEY/g)?.length).toBe(1)
  })

  test('every scaffold fits a result whole: nothing is cut, capped or left out', async () => {
    // A result is capped at 64,000 characters and a string at 512 by default; a scaffold's
    // files are returned whole or the tool is of no use. The native examples are the
    // largest, so every tool is asked for every framework and compared with the module.
    const { client, close } = await connect({ cwd: import.meta.dir })
    for (const tool of Object.keys(TOOLS)) {
      for (const framework of SCAFFOLD_FRAMEWORKS) {
        const answer = await callTool(client, tool, { framework })
        expect(`${tool} ${framework}: ${answer.isError}`).toBe(`${tool} ${framework}: false`)
        expect(answer.text.length).toBeLessThan(64_000)
        const files = answer.structured.files as { path: string; contents: string }[]
        const expected = SCAFFOLD_FILES[framework][TOOLS[tool as keyof typeof TOOLS]]
        expect(files.map((file) => file.contents.length)).toEqual(
          expected.map((file) => file.contents.length)
        )
      }
    }
    await close()
  })

  test('the native scaffolds say where the SDK comes from, and invent no registry for it', async () => {
    const { client, close } = await connect({ cwd: import.meta.dir })
    const swift = await callTool(client, 'scaffold_provider', { framework: 'swiftui' })
    const compose = await callTool(client, 'scaffold_provider', { framework: 'compose' })
    await close()
    for (const answer of [swift, compose]) {
      const notes = (answer.structured.notes as string[]).join('\n')
      expect(notes).toContain('not published')
      expect(notes).toContain('a checkout of the Tula repository')
      expect(notes).toContain('Nobody has run them on a phone')
      // No address of a package, no coordinate.
      expect(JSON.stringify(answer.structured.dependencies)).not.toMatch(/[:/@]/)
    }
  })

  test('a scaffold call touches neither the network nor the disk', async () => {
    const { mkdtemp, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const cwd = await mkdtemp(join(tmpdir(), 'tula-mcp-scaffold-'))
    const { client, close } = await connect({ cwd })
    for (const tool of Object.keys(TOOLS)) {
      for (const framework of SCAFFOLD_FRAMEWORKS) {
        await callTool(client, tool, { framework })
      }
    }
    await close()
    expect(await readdir(cwd)).toEqual([])
  })
})
