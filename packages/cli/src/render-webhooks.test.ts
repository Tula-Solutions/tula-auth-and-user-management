import { describe, expect, test } from 'bun:test'
import { defineConfig, type EnvironmentConfigInput } from '@tula/config'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { buildPlan, orderOperations, type Plan, type RemoteWebhook } from './diff'
import { createOutput } from './output'
import { describeOperation, planBlockers, planWarnings, renderPlan } from './render'

// What an operator reads about webhook endpoints in a plan, word for word. The behaviour
// against the API is in real-api.test.ts; these are the lines no API state makes easy.

const HOOK = 'https://hooks.northline.app/tula'

function endpoint(id: number, over: Partial<RemoteWebhook> = {}): RemoteWebhook {
  return {
    id: `00000000-0000-7000-8000-${String(id).padStart(12, '0')}`,
    url: `${HOOK}/${id}`,
    eventTypes: ['user.created'],
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastFailedAt: null,
    rotationOverlapEndsAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function plan(
  webhooks: NonNullable<EnvironmentConfigInput['webhooks']>,
  remote: RemoteWebhook[],
  prune = false
): Plan {
  const environment = defineConfig({ environments: { dev: { webhooks } } }).environments.dev
  if (!environment) {
    throw new Error('fixture')
  }
  return buildPlan(
    {
      revision: 1,
      settings: structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
      managedBy: null,
      providers: [],
      webhooks: remote,
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

describe('a plan’s words about webhook endpoints', () => {
  test('switching on an endpoint the server switched off says so on its line and as a warning', () => {
    const result = plan(
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: true }],
      [endpoint(1, { enabled: false, disabledReason: 'failing' })]
    )
    expect(rendered(result)).toContain(
      `  ~ ${HOOK}/1: update (enabled false → true (the server had switched it off: failing))`
    )
    expect(planWarnings(result)).toContain(
      `switches on a webhook endpoint the server switched off (${HOOK}/1: failing); if it still fails the server switches it off again`
    )
  })

  test('an endpoint a person switched off is switched on without a warning', () => {
    const result = plan(
      [{ url: `${HOOK}/1`, eventTypes: ['user.created'], enabled: true }],
      [endpoint(1, { enabled: false })]
    )
    expect(rendered(result)).toContain(`  ~ ${HOOK}/1: update (enabled false → true)\n`)
    expect(planWarnings(result).join('\n')).not.toContain('switched off')
  })

  test('a changed address is said in words: a new endpoint, a new secret, the old one’s log goes with it', () => {
    const note =
      '  an endpoint is its address: a changed address is a new endpoint with a new signing secret; the old one stays until it is removed (--prune), and its pending deliveries and its delivery log go with it'
    const moved = [{ url: `${HOOK}/moved`, eventTypes: ['user.created' as const], enabled: false }]
    const kept = rendered(plan(moved, [endpoint(1)]))
    expect(kept).toContain(
      `  + ${HOOK}/moved: create (eventTypes "user.created", enabled false; a signing secret is made, shown once)`
    )
    expect(kept).toContain(note)
    expect(rendered(plan(moved, [endpoint(1)], true))).toContain(note)
    expect(rendered(plan(moved, []))).not.toContain(note)
  })

  test('several of each are counted in the plural', () => {
    const result = plan(
      [
        { url: `${HOOK}/a`, eventTypes: ['user.created'] },
        { url: `${HOOK}/b`, eventTypes: ['user.created'] },
      ],
      Array.from({ length: 10 }, (_, index) => endpoint(index + 1)),
      true
    )
    expect(planWarnings(result)).toEqual([
      'removes 10 webhook endpoints with their pending deliveries and their delivery logs, for good (`tula apply --yes` needs --allow-webhook-removal)',
      'creates 2 webhook endpoints: each signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)',
      'the environment is at its limit of 10 webhook endpoints: 2 of the removals are made before the new endpoints are created, to make room',
    ])
    expect(orderOperations(result).map(describeOperation).slice(1, 4)).toEqual([
      `webhook ${HOOK}/1: remove`,
      `webhook ${HOOK}/2: remove`,
      `webhook ${HOOK}/a: create`,
    ])
  })

  test('a list that is empty on both sides says so', () => {
    expect(rendered(plan([], []))).toContain('Webhooks\n  none in the file, none on the server\n')
  })

  test('what the server sent is printed without what a terminal would act on or a reader cannot see', () => {
    const hidden = `${HOOK}/\u{202E}gnp.exe`
    const result = plan(
      [{ url: HOOK, eventTypes: ['user.created'], enabled: true }],
      [
        endpoint(1, { url: HOOK, enabled: false, disabledReason: 'failing\u001b[2J\u{202E}' }),
        endpoint(2, { url: hidden }),
        endpoint(3, { url: HOOK }),
      ]
    )
    const text = `${rendered(result)}\n${planBlockers(result).join('\n')}\n${planWarnings(result).join('\n')}`
    expect(text).toContain(`= ${HOOK}/gnp.exe: unmanaged`)
    expect(text).not.toContain('\u{202E}')
    expect(text).not.toContain('\u001b')
  })
})
