import { type RenderResult, render } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { PASSWORD_POLICY_PRESETS, type PasswordPolicy } from '@tula/contract'
import type { FlowKind, FlowStep, TulaClient } from '@tula/core'
import type { ReactElement } from 'react'
// The core client's own test doubles: a fake API that records requests, and an environment
// with no cross-tab channel (Bun has a global BroadcastChannel, which would let one test's
// sign-out reach another test's client).
import { createClient } from '../../../core/src/client'
import {
  type FakeApi,
  type FakeLinkStorage,
  type FakePage,
  type FakeTimers,
  failure,
  fakeApi,
  fakeEnvironment,
  fakeLinkStorage,
  fakePage,
  fakeTimers,
  json,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from '../../../core/src/testing/fakes'
import { TulaProvider, type TulaProviderProps } from '../context'

export {
  type FakeLinkStorage,
  type FakeTimers,
  failure,
  fakeLinkStorage,
  fakePage,
  fakeTimers,
  json,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
}

/** The routes the components call, as the fake API names them. */
export const ROUTE = {
  refresh: 'POST /v1/client/sessions/refresh',
  me: 'GET /v1/client/me',
  config: 'GET /v1/client/config',
  sessions: 'GET /v1/client/sessions',
  signOut: 'POST /v1/client/sessions/sign-out',
  revokeOthers: 'POST /v1/client/sessions/revoke-others',
  changePassword: 'POST /v1/client/me/password',
  signIn: 'POST /v1/client/sign-ins',
  signInPassword: 'POST /v1/client/sign-ins/attempt_1/password',
  signInVerify: 'POST /v1/client/sign-ins/attempt_1/verify-email',
  signInResend: 'POST /v1/client/sign-ins/attempt_1/resend-code',
  signInPrepare: 'POST /v1/client/sign-ins/attempt_1/first-factor/prepare',
  signInAttempt: 'POST /v1/client/sign-ins/attempt_1/first-factor/attempt',
  signInLink: 'POST /v1/client/sign-ins/link',
  signUp: 'POST /v1/client/sign-ups',
  signUpVerify: 'POST /v1/client/sign-ups/attempt_1/verify-email',
  signUpResend: 'POST /v1/client/sign-ups/attempt_1/resend-code',
  reset: 'POST /v1/client/password-resets',
  resetSubmit: 'POST /v1/client/password-resets/attempt_1/password',
  resetResend: 'POST /v1/client/password-resets/attempt_1/resend-code',
} as const

/** A step as any answer after the start carries it. */
export function attempt(kind: FlowKind, step: FlowStep | { status: string }, extra: object = {}) {
  return json(200, {
    id: 'attempt_1',
    kind,
    expiresAt: '2030-01-01T00:10:00.000Z',
    step,
    ...extra,
  })
}

/** The answer to a start: the step plus the attempt's secret. */
export function started(kind: FlowKind, step: FlowStep | { status: string }) {
  return attempt(kind, step, { attemptSecret: 'tula_at_test_secret' })
}

/** The answer that completes a flow and signs the client in. */
export function completed(kind: FlowKind) {
  return attempt(
    kind,
    { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
    { session: sessionTokens('signed_in') }
  )
}

export const CODE_STEP: FlowStep = {
  status: 'needs_email_verification',
  destination: 'm***@northline.app',
  strategies: ['email_code'],
}

export const NEW_PASSWORD_STEP: FlowStep = {
  status: 'needs_new_password',
  destination: 'm***@northline.app',
  strategies: ['email_code'],
}

/** A fake API, a client that talks to it, and a way to mount components under a provider. */
export interface World {
  api: FakeApi
  client: TulaClient
  user: UserEvent
  mount(ui: ReactElement, provider?: Partial<TulaProviderProps>): RenderResult
}

/** What a test can decide about the world's "browser". */
export interface WorldOptions {
  /** Whether the browser has a session to restore. */
  signedIn?: boolean
  /** The environment's password policy. */
  policy?: PasswordPolicy
  /** Whether a sign-up may leave the password out. */
  signUpPassword?: 'required' | 'optional'
  /** Storage shared by the browser's tabs; without it an emailed link cannot be used. */
  linkStorage?: FakeLinkStorage
  /** The address the page was opened at, for the page an emailed link leads to. */
  page?: FakePage
  /** Timers the test fires by hand; real ones otherwise. */
  timers?: FakeTimers
}

/**
 * @param options - What the browser and the environment are like.
 * @returns The world.
 */
export function world(options: WorldOptions = {}): World {
  const api = fakeApi()
  api.on(ROUTE.refresh, () =>
    options.signedIn ? json(200, sessionTokens('access_1')) : failure(401, 'auth.unauthenticated')
  )
  api.on(ROUTE.me, () => json(200, TEST_USER))
  api.on(ROUTE.config, () =>
    json(200, {
      app: { name: 'Northline', supportEmail: null },
      signIn: { methods: ['password'] },
      signUp: { password: options.signUpPassword ?? 'required' },
      password: options.policy ?? PASSWORD_POLICY_PRESETS.recommended,
    })
  )
  api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
  const client = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: api.fetch },
    fakeEnvironment(manualClock(), {
      linkStorage: options.linkStorage,
      page: options.page,
      timers: options.timers,
    })
  )
  return {
    api,
    client,
    user: userEvent.setup(),
    mount: (ui, provider = {}) =>
      render(
        <TulaProvider client={client} {...(provider as object)}>
          {ui}
        </TulaProvider>
      ),
  }
}
