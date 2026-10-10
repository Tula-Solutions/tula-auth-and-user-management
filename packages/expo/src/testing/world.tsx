import { renderHook } from '@testing-library/react'
import type { AuthState, FlowKind, FlowStep, TulaClient } from '@tula/core'
import { type ReactNode, StrictMode } from 'react'
// The core client's own test doubles: a fake API that records requests.
import {
  type FakeApi,
  failure,
  fakeApi,
  json,
  sessionTokens,
  TEST_BASE_URL,
  TEST_USER,
} from '../../../core/src/testing/fakes'
import { createExpoClient, type TulaExpoClientOptions } from '../client'
import { TulaProvider } from '../context'
import { secureStoreKey } from '../secure-storage'
import { type FakeSecureStore, fakeSecureStore } from './fake-secure-store'

export { failure, json, sessionTokens, TEST_BASE_URL, TEST_USER }

/** The routes the hooks call, as the fake API names them. */
export const ROUTE = {
  refresh: 'POST /v1/client/sessions/refresh',
  me: 'GET /v1/client/me',
  sessions: 'GET /v1/client/sessions',
  signOut: 'POST /v1/client/sessions/sign-out',
  revokeOthers: 'POST /v1/client/sessions/revoke-others',
  signIn: 'POST /v1/client/sign-ins',
  signInPassword: 'POST /v1/client/sign-ins/attempt_1/password',
  signInNewPassword: 'POST /v1/client/sign-ins/attempt_1/new-password',
  signInVerify: 'POST /v1/client/sign-ins/attempt_1/verify-email',
  signInResend: 'POST /v1/client/sign-ins/attempt_1/resend-code',
  signInPrepare: 'POST /v1/client/sign-ins/attempt_1/first-factor/prepare',
  signInAttempt: 'POST /v1/client/sign-ins/attempt_1/first-factor/attempt',
  signInSecondPrepare: 'POST /v1/client/sign-ins/attempt_1/second-factor/prepare',
  signInSecond: 'POST /v1/client/sign-ins/attempt_1/second-factor',
  signInTotpStart: 'POST /v1/client/sign-ins/attempt_1/factor-enrolment/totp',
  signInTotpConfirm: 'POST /v1/client/sign-ins/attempt_1/factor-enrolment/totp/confirm',
  signUp: 'POST /v1/client/sign-ups',
  signUpVerify: 'POST /v1/client/sign-ups/attempt_1/verify-email',
  signUpResend: 'POST /v1/client/sign-ups/attempt_1/resend-code',
  reset: 'POST /v1/client/password-resets',
  resetSubmit: 'POST /v1/client/password-resets/attempt_1/password',
  resetResend: 'POST /v1/client/password-resets/attempt_1/resend-code',
  resetSecondPrepare: 'POST /v1/client/password-resets/attempt_1/second-factor/prepare',
  resetSecond: 'POST /v1/client/password-resets/attempt_1/second-factor',
} as const

/** A step as a test sends it: one of the contract, or one a newer server might send. */
export type SentStep = FlowStep | { status: string; [key: string]: unknown }

/** A step as any answer after the start carries it. */
export function attempt(kind: FlowKind, step: SentStep, extra: object = {}) {
  return json(200, {
    id: 'attempt_1',
    kind,
    expiresAt: '2030-01-01T00:10:00.000Z',
    step,
    ...extra,
  })
}

/** The answer to a start: the step plus the attempt's secret. */
export function started(kind: FlowKind, step: SentStep) {
  return attempt(kind, step, { attemptSecret: 'tula_at_test_secret' })
}

/** The answer that completes a flow and signs the client in, with the token an app stores. */
export function completed(kind: FlowKind) {
  return attempt(
    kind,
    { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
    { session: sessionTokens('signed_in', { refreshToken: 'rt_signed_in' }) }
  )
}

/** A phone: a fake API, a secure store, the package's client and a way to run a hook. */
export interface World {
  api: FakeApi
  store: FakeSecureStore
  client: TulaClient
  /** Every state the client has announced. */
  states: AuthState[]
  /** What the secure store holds for this client's refresh token, or `undefined`. */
  storedToken(): string | undefined
  /**
   * Run a hook under `<TulaProvider>`.
   *
   * @param hook - The hook.
   * @param strict - Wrap in `<StrictMode>`, which runs effects twice.
   */
  render<Result>(
    hook: () => Result,
    strict?: boolean
  ): { result: { current: Result }; unmount(): void }
}

let worlds = 0

/**
 * @param options - `signedIn`: the secure store holds a refresh token the API accepts.
 *   `platform`: what the app runs on. `client`: more options for the client.
 * @returns A world.
 */
export function world(
  options: { signedIn?: boolean; platform?: string; client?: Partial<TulaExpoClientOptions> } = {}
): World {
  worlds += 1
  // A key per world: Bun has a global BroadcastChannel, and clients that share a key would
  // hear each other's sign-outs across tests.
  const publishableKey = `tula_pk_dev_expo${String(worlds).padStart(26, '0')}`
  const api = fakeApi()
  const store = fakeSecureStore()
  const entry = `/${secureStoreKey(`tula.refresh.${TEST_BASE_URL}|${publishableKey}`)}`
  if (options.signedIn) {
    store.entries.set(entry, 'rt_0')
  }
  api.on(ROUTE.refresh, () => json(200, sessionTokens('restored', { refreshToken: 'rt_1' })))
  api.on(ROUTE.me, () => json(200, TEST_USER))
  const states: AuthState[] = []
  const client = createExpoClient(
    {
      publishableKey,
      baseUrl: TEST_BASE_URL,
      fetch: api.fetch,
      onSessionChange: (state) => states.push(state),
      ...options.client,
    },
    { platform: options.platform ?? 'ios', secureStore: store }
  )
  return {
    api,
    store,
    client,
    states,
    storedToken: () => store.entries.get(entry),
    render(hook, strict = false) {
      const provided = (props: { children: ReactNode }) => (
        <TulaProvider client={client}>{props.children}</TulaProvider>
      )
      const wrapper = strict
        ? (props: { children: ReactNode }) => <StrictMode>{provided(props)}</StrictMode>
        : provided
      return renderHook(hook, { wrapper })
    },
  }
}
