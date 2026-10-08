import { describe, expect, test } from 'bun:test'
import { defineConfig, type EnvironmentConfigInput } from '@tula/config'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { buildPlan, orderOperations, type Plan, type RemoteHook } from './diff'
import { createOutput } from './output'
import { applyRequirements, describeOperation, planWarnings, renderPlan } from './render'

// What an operator reads about hooks in a plan, word for word. The behaviour against the API
// is in real-api.test.ts; these are the lines no API state makes easy.

const ASK = 'https://api.northline.app/hooks'

function hook(point: string, over: Partial<RemoteHook> = {}): RemoteHook {
  return {
    id: `id-${point}`,
    point,
    url: `${ASK}/${point}`,
    enabled: true,
    deadlineMs: 2000,
    failureMode: 'deny',
    lastFailedAt: null,
    lastFailureReason: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function plan(
  hooks: NonNullable<EnvironmentConfigInput['hooks']>,
  remote: RemoteHook[],
  prune = false
): Plan {
  const environment = defineConfig({ environments: { dev: { hooks } } }).environments.dev
  if (!environment) {
    throw new Error('fixture')
  }
  return buildPlan(
    {
      revision: 1,
      settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
      managedBy: null,
      providers: [],
      hooks: remote,
    },
    environment,
    { configHash: `sha256:${'0'.repeat(64)}`, prune }
  )
}

function rendered(result: Plan): string {
  let text = ''
  const sink = { write: (chunk: string) => (text += chunk) }
  renderPlan(
    createOutput(sink, sink, {}),
    { environment: 'dev', apiUrl: 'https://a.example' },
    result
  )
  return text
}

describe('a plan’s words about hooks', () => {
  test('every kind of line, and the weakenings by their paths', () => {
    const result = plan(
      {
        before_sign_up: { url: `${ASK}/before_sign_up`, failureMode: 'allow', deadlineMs: 800 },
        before_session: { url: `${ASK}/before_session` },
      },
      [hook('before_sign_up'), hook('before_token')],
      true
    )
    expect(rendered(result)).toContain(
      'Hooks\n' +
        '  ~ before_sign_up: update (deadlineMs 2000 → 800, failureMode "deny" → "allow")\n' +
        `  + before_session: create (url ${ASK}/before_session, enabled true, deadlineMs 2000, failureMode "deny"; a signing secret is made, shown once)\n` +
        `  - before_token: remove (${ASK}/before_token), with its signing secret\n`
    )
    expect(planWarnings(result)).toEqual([
      'weakens security: hooks.before_sign_up.failureMode, hooks.before_token (`tula apply --yes` needs --allow-weaker)',
      'creates 1 hook: its signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)',
    ])
    expect(applyRequirements(result)).toEqual({
      allowUnknown: false,
      allowWeaker: true,
      allowWebhookRemoval: false,
      webhookSecrets: false,
      hookSecrets: true,
    })
    expect(orderOperations(result).map(describeOperation)).toEqual([
      'settings: replace',
      'hook before_session: create',
      'hook before_sign_up: update',
      'hook before_token: remove',
    ])
  })

  test('several new hooks are counted in the plural', () => {
    const result = plan(
      { before_sign_up: { url: `${ASK}/a` }, before_token: { url: `${ASK}/b` } },
      []
    )
    expect(planWarnings(result)).toEqual([
      'creates 2 hooks: each signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)',
    ])
  })

  test('an unchanged, an unmanaged and an unknown hook each say which they are', () => {
    const text = rendered(
      plan({ before_sign_up: { url: `${ASK}/before_sign_up` } }, [
        hook('before_sign_up'),
        hook('before_token'),
        hook('before_refresh'),
      ])
    )
    expect(text).toContain('  = before_sign_up: unchanged\n')
    expect(text).toContain(
      '  = before_token: unmanaged (on the server, not in the file; --prune removes it)\n'
    )
    expect(text).toContain(
      '  = before_refresh: a point this version of tula does not know (left alone, also with --prune)\n'
    )
  })

  test('a key that is empty on both sides says so; a file without the key has no section', () => {
    expect(rendered(plan({}, []))).toContain('Hooks\n  none in the file, none on the server\n')
    const environment = defineConfig({ environments: { dev: {} } }).environments.dev
    if (!environment) {
      throw new Error('fixture')
    }
    const unmanaged = buildPlan(
      {
        revision: 1,
        settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
        managedBy: null,
        providers: [],
      },
      environment,
      { configHash: `sha256:${'0'.repeat(64)}` }
    )
    expect(rendered(unmanaged)).not.toContain('Hooks')
  })

  test('what the server sent is printed without what a terminal would act on or a reader cannot see', () => {
    const result = plan(
      { before_sign_up: { url: `${ASK}/moved` } },
      [
        hook('before_sign_up', { url: `${ASK}/\u{202E}gnp.exe\u001b[2J` }),
        hook('before_\u{202E}later\u001b[2J'),
      ],
      true
    )
    const text = rendered(result)
    expect(text).toContain(`  ~ before_sign_up: update (url ${ASK}/gnp.exe [2J → ${ASK}/moved)\n`)
    expect(text).toContain('  = before_later [2J: a point this version of tula does not know')
    expect(text).not.toContain('\u{202E}')
    expect(text).not.toContain('\u001b')
  })
})
