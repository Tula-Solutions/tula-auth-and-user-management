import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadScenarios, SCENARIOS_DIR } from './load'

const directories: string[] = []
async function directory(files: Record<string, string>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tula-conformance-'))
  directories.push(path)
  await Promise.all(Object.entries(files).map(([name, text]) => Bun.write(join(path, name), text)))
  return path
}
afterAll(() => Promise.all(directories.map((path) => rm(path, { recursive: true }))))

const valid = JSON.stringify({
  name: 'ok',
  description: 'A scenario.',
  steps: [{ name: 'wait', wait: '1s' }],
})

describe('loadScenarios', () => {
  test('loads the scenarios shipped with the repository, in file order', async () => {
    const loaded = await loadScenarios()
    expect(SCENARIOS_DIR.endsWith('conformance/scenarios')).toBe(true)
    expect(loaded.length).toBeGreaterThanOrEqual(7)
    const files = loaded.map((entry) => entry.file)
    expect(files).toEqual([...files].sort())
    expect(new Set(loaded.map((entry) => entry.scenario.name)).size).toBe(loaded.length)
  })

  test('reads only .json files and applies defaults', async () => {
    const path = await directory({ 'b.json': valid, 'a.json': valid, 'README.md': '# notes' })
    const loaded = await loadScenarios(path)
    expect(loaded.map((entry) => entry.file)).toEqual(['a.json', 'b.json'])
  })

  test.each([
    ['invalid JSON', '{ not json'],
    ['no steps', JSON.stringify({ name: 'x', description: 'y', steps: [] })],
    [
      'an unknown key, which is how a typo shows up',
      JSON.stringify({ name: 'x', description: 'y', steps: [{ name: 's', wiat: '1s' }] }),
    ],
    [
      'a step that mixes two kinds',
      JSON.stringify({
        name: 'x',
        description: 'y',
        steps: [{ name: 's', wait: '1s', emailCode: { to: 'a', capture: 'b' } }],
      }),
    ],
    [
      'a malformed duration',
      JSON.stringify({ name: 'x', description: 'y', steps: [{ name: 's', wait: 'soon' }] }),
    ],
  ])('rejects a file with %s, naming the file', async (_name, text) => {
    const path = await directory({ 'broken.json': text })
    await expect(loadScenarios(path)).rejects.toThrow(/^broken\.json: /)
  })
})
