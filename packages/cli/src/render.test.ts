import { describe, expect, test } from 'bun:test'
import { defineConfig } from '@tula-tech/config'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { buildPlan } from './diff'
import { createOutput } from './output'
import { renderPlan } from './render'

describe('a plan shows what the server holds as printable text (H-267)', () => {
  test('bidi, line-separator and C1 characters in a server setting never reach the terminal', () => {
    const environment = defineConfig({
      environments: { dev: { settings: { app: { name: 'Mine' } } } },
    }).environments.dev
    if (!environment) {
      throw new Error('fixture')
    }
    const server = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    server.app.name = 'a‮b c\u0085d​e'
    const plan = buildPlan(
      { revision: 1, settings: server, managedBy: null, providers: [] },
      environment,
      { configHash: `sha256:${'0'.repeat(64)}` }
    )
    let text = ''
    const sink = { write: (chunk: string) => (text += chunk) }
    renderPlan(
      createOutput(sink, sink, {}),
      { environment: 'dev', apiUrl: 'https://a.example' },
      plan
    )
    expect(text).toContain('app.name')
    for (const bad of ['‮', ' ', '\u0085', '​']) {
      expect(text).not.toContain(bad)
    }
  })
})
