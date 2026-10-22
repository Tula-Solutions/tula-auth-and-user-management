import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildItem, buildRegistry, drift, itemUrl, RegistryError, refusalsOf } from './build'
import { ITEMS, itemNamed, REGISTRY, SHADCN } from './registry'

const root = resolve(import.meta.dir, '..')
const read = (source: string) => readFileSync(join(root, 'items', source), 'utf8')
const baseUrl = REGISTRY.baseUrl
const built = () => buildRegistry({ read, baseUrl })
const sha256 = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, 'schema', file)))
    .digest('hex')

describe('the pinned shadcn schema', () => {
  test('the vendored schemas are the ones the pin names', () => {
    // A move to a newer registry format is a decision with a diff (ADR 0064), never a download.
    expect(sha256('registry-item.json')).toBe(SHADCN.itemSchemaSha256)
    expect(sha256('registry.json')).toBe(SHADCN.registrySchemaSha256)
  })

  test('every key and type an item emits is in the vendored schema', () => {
    const schema = JSON.parse(readFileSync(join(root, 'schema/registry-item.json'), 'utf8'))
    const known = new Set(Object.keys(schema.properties))
    const types = new Set<string>(schema.properties.type.enum)
    for (const file of built()) {
      if (file.name === 'registry.json') {
        continue
      }
      const item = JSON.parse(file.text) as Record<string, unknown>
      for (const key of Object.keys(item)) {
        expect(key === '$schema' || known.has(key)).toBe(true)
      }
      expect(types.has(String(item.type))).toBe(true)
    }
  })
})

describe('the built registry', () => {
  test('is registry.json and one file per item, in order', () => {
    expect(built().map((file) => file.name)).toEqual([
      'registry.json',
      ...ITEMS.map((item) => `${item.name}.json`),
    ])
  })

  test('the index lists every item without the text of its files', () => {
    const index = JSON.parse(built()[0]?.text ?? '{}')
    expect(index.name).toBe('tula')
    expect(index.items.map((item: { name: string }) => item.name)).toEqual(
      ITEMS.map((item) => item.name)
    )
    expect(JSON.stringify(index)).not.toContain('"content"')
  })

  test('an item names another item of the registry by its address', () => {
    const signIn = JSON.parse(built().find((file) => file.name === 'sign-in.json')?.text ?? '{}')
    expect(signIn.registryDependencies).toEqual([
      'button',
      'input',
      'label',
      itemUrl(baseUrl, 'step-card'),
      itemUrl(baseUrl, 'status'),
    ])
    expect(signIn.dependencies.every((entry: string) => entry.startsWith('@tula-tech/react'))).toBe(
      true
    )
  })

  test('every item that has files carries their text', () => {
    const signIn = JSON.parse(built().find((file) => file.name === 'sign-in.json')?.text ?? '{}')
    expect(signIn.files[0].content).toBe(read('sign-in.tsx'))
    expect(signIn.files[0].target).toBe('@components/tula/sign-in.tsx')
  })

  test('the committed r/ is what the sources write', () => {
    const present = readdirSync(join(root, 'r')).filter((name) => name.endsWith('.json'))
    expect(
      drift(
        built(),
        (name) => {
          try {
            return readFileSync(join(root, 'r', name), 'utf8')
          } catch {
            return null
          }
        },
        present
      )
    ).toEqual([])
  })
})

describe('drift', () => {
  const files = [{ name: 'a.json', text: 'one' }]

  test('a file that is out of date', () => {
    expect(drift(files, () => 'two', ['a.json'])).toEqual(['a.json is out of date'])
  })

  test('a file that is missing', () => {
    expect(drift(files, () => null, [])).toEqual(['a.json is missing'])
  })

  test('a file that is no longer an item', () => {
    expect(drift(files, () => 'one', ['a.json', 'gone.json'])).toEqual([
      'gone.json is not an item of the registry any more',
    ])
  })

  test('nothing, when the files are the sources', () => {
    expect(drift(files, () => 'one', ['a.json'])).toEqual([])
  })
})

describe('registry:check', () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(['bun', 'run', 'scripts/registry.ts', '--base-url', baseUrl, ...args], {
      cwd: root,
      // Each run starts `bun`, which can take a second on a slow runner.
      timeout: 30_000,
    })

  // Two spawns and a generate: sized to them (AGENTS.md, "Testing").
  test('passes on a fresh build and exits non-zero once a file drifts', () => {
    const out = mkdtempSync(join(tmpdir(), 'tula-registry-'))
    try {
      expect(run('--out', out).exitCode).toBe(0)
      expect(run('--check', '--out', out).exitCode).toBe(0)
      writeFileSync(join(out, 'status.json'), '{}\n')
      const drifted = run('--check', '--out', out)
      expect(drifted.exitCode).toBe(1)
      expect(drifted.stderr.toString()).toContain('status.json is out of date')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 90_000)
})

describe('the refusals reach the build', () => {
  const sign = itemNamed('sign-in')
  if (!sign) {
    throw new Error('the registry has no sign-in item')
  }

  test('a refused file stops the build with every reason', () => {
    const bad = () => `import { x } from '@tula-tech/core'\nexport const y = () => console.log(x)\n`
    expect(() => buildItem(sign, { read: bad, baseUrl })).toThrow(RegistryError)
    const refusals = refusalsOf(sign, { read: bad })
    expect(refusals.map((refusal) => refusal.rule).sort()).toEqual(
      expect.arrayContaining(['console', 'imports-core'])
    )
  })

  test('an import the item does not declare is refused', () => {
    const undeclared = () =>
      `import { Badge } from '@/components/ui/badge'\nexport const y = Badge\n`
    expect(refusalsOf(sign, { read: undeclared }).map((refusal) => refusal.rule)).toContain(
      'import-not-allowed'
    )
  })

  test('the items of the registry pass', () => {
    for (const item of ITEMS) {
      expect(refusalsOf(item, { read })).toEqual([])
    }
  })
})
