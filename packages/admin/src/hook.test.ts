import { describe, expect, test } from 'bun:test'
import { EVENT_FIXTURES, HOOK_QUESTION_FIXTURES, HOOK_QUESTION_TYPES } from '@tula/contract'
import {
  formatWebhookSecret,
  signWebhook,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import { isTulaAdminError, type TulaAdminError } from './errors'
import { HOOK_QUESTION_TYPE_NAMES, type TulaHookAnswer, verifyHook } from './hook'
import { verifyWebhook } from './webhook'

const SECRET = formatWebhookSecret(new Uint8Array(32).fill(51))
const OTHER_SECRET = formatWebhookSecret(new Uint8Array(32).fill(52))
const NOW = Date.parse('2026-10-08T09:30:00.000Z')
const SECONDS = Math.floor(NOW / 1000)
const question = HOOK_QUESTION_FIXTURES.before_sign_up

async function signed(
  payload: unknown,
  { secret = SECRET, id = question.id as string | undefined, timestamp = SECONDS } = {}
) {
  const body = JSON.stringify(payload)
  const key = webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>
  const headerId = id ?? (payload as { id: string }).id
  return {
    body,
    headers: {
      'webhook-id': headerId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook(key, headerId, timestamp, body),
    },
  }
}

async function failure(work: Promise<unknown>): Promise<TulaAdminError> {
  try {
    await work
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the verification to fail')
}

const verify = (request: { body: string; headers: Record<string, string> }, secret = SECRET) =>
  verifyHook(request.body, request.headers, secret, { now: NOW })

describe('verifyHook', () => {
  test('returns the question of a request signed with the hook’s secret', async () => {
    const asked = await verify(await signed(question))
    expect(asked).toEqual(question)
    // Typed by `type`: the data of a sign-up is the address, the method, the client, the IP.
    if (asked.type === 'hook.before_sign_up') {
      expect(asked.data.email).toBe('ada@example.com')
    }
    const answer: TulaHookAnswer = { decision: 'deny', code: 'disposable_email' }
    expect(answer.decision).toBe('deny')
  })

  test('knows exactly the question types the contract has', () => {
    expect([...HOOK_QUESTION_TYPE_NAMES].sort()).toEqual(Object.values(HOOK_QUESTION_TYPES).sort())
  })

  test('takes the headers as a Headers object and the body as bytes', async () => {
    const request = await signed(question)
    const asked = await verifyHook(
      new TextEncoder().encode(request.body),
      new Headers(request.headers),
      SECRET,
      { now: NOW }
    )
    expect(asked.id).toBe(question.id)
  })

  test.each([
    ['another secret', {}, OTHER_SECRET, 'hook.invalid_signature'],
    ['a secret that is not one', {}, 'tula_sk_dev_x', 'hook.invalid_secret'],
    [
      'a timestamp six minutes old',
      { timestamp: SECONDS - 360 },
      SECRET,
      'hook.timestamp_out_of_tolerance',
    ],
    [
      'a timestamp six minutes ahead',
      { timestamp: SECONDS + 360 },
      SECRET,
      'hook.timestamp_out_of_tolerance',
    ],
  ] as const)('refuses %s', async (_name, options, secret, code) => {
    const error = await failure(verify(await signed(question, options), secret))
    expect(error.code).toBe(code)
    expect(error.status).toBe(0)
    expect(JSON.stringify([error.message, error.code])).not.toContain(SECRET)
  })

  test('refuses a body that was changed after it was signed', async () => {
    const request = await signed(question)
    const tampered = request.body.replace('ada@example.com', 'eve@example.com')
    const error = await failure(verify({ ...request, body: tampered }))
    expect(error.code).toBe('hook.invalid_signature')
  })

  test.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'refuses a request without %s',
    async (name) => {
      const request = await signed(question)
      const { [name]: _dropped, ...headers } = request.headers
      const error = await failure(verify({ body: request.body, headers }))
      expect(error.code).toBe('hook.invalid_headers')
    }
  )

  // Each is signed correctly with the hook's own secret: the signature is not what refuses it.
  test.each([
    ['an event', EVENT_FIXTURES['user.created']],
    ['an event about a hook, whose type also begins with hook.', EVENT_FIXTURES['hook.created']],
    ['a test event', { ...EVENT_FIXTURES['user.created'], test: true }],
    ['a question of a type this version does not know', { ...question, type: 'hook.before_token' }],
    ['a question with an actor', { ...question, actor: { type: 'user', id: 'u' } }],
    ['a question with a target', { ...question, target: { type: 'user', id: 'u' } }],
    ['a question with no data', { ...question, data: undefined }],
    ['a question whose data is a list', { ...question, data: [] }],
    ['a question with no schema version', { ...question, schemaVersion: undefined }],
    ['a list', [question]],
    ['a string', 'allow'],
  ])('refuses %s as not a question', async (_name, payload) => {
    const id = (payload as { id?: string }).id ?? question.id
    const error = await failure(verify(await signed(payload, { id })))
    expect(error.code).toBe('hook.invalid_payload')
  })

  test('refuses a question whose id is not the one in the header', async () => {
    const request = await signed(question, { id: '0199c2f6-0000-7000-8000-00000000ffff' })
    expect((await failure(verify(request))).code).toBe('hook.invalid_payload')
  })

  test('refuses signed text that is not JSON', async () => {
    const key = webhookSecretBytes(SECRET) as Uint8Array<ArrayBuffer>
    const headers = {
      'webhook-id': question.id,
      'webhook-timestamp': String(SECONDS),
      'webhook-signature': await signWebhook(key, question.id, SECONDS, 'not json'),
    }
    expect((await failure(verify({ body: 'not json', headers }))).code).toBe('hook.invalid_payload')
  })
})

describe('verifyWebhook', () => {
  test('refuses a hook’s question, even signed with the endpoint’s own secret', async () => {
    const request = await signed(question)
    const error = await failure(verifyWebhook(request.body, request.headers, SECRET, { now: NOW }))
    expect(error.code).toBe('webhook.invalid_payload')
  })
})
