import { expect } from 'bun:test'
import { type RenderResult, render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { PASSWORD_POLICY_PRESETS, type PasswordPolicy } from '@tula/contract'
import type { FlowKind, FlowStep, TulaClient } from '@tula/core'
import type { ReactElement } from 'react'
// The core client's own test doubles: a fake API that records requests, and an environment
// with no cross-tab channel (Bun has a global BroadcastChannel, which would let one test's
// sign-out reach another test's client).
import { createClient } from '../../../core/src/client'
import type { PasskeyGlobals } from '../../../core/src/passkey'
import { memoryStorage } from '../../../core/src/storage'
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

/**
 * How many dialogs are on the page, for waiting until one has closed:
 * `await waitFor(() => expect(openDialogs()).toBe(0))`.
 *
 * Never hand `expect` the element itself inside a `waitFor`. A matcher that fails formats what
 * it received, and a happy-dom element drags its whole window along: one failed poll builds a
 * message of over a hundred megabytes, synchronously, which takes about a second on a laptop
 * and long enough on a CI runner that the test dies at its timeout while the page was right.
 *
 * @returns The number of elements with the `dialog` role.
 */
export function openDialogs(): number {
  return screen.queryAllByRole('dialog').length
}

/**
 * Wait until focus is on an element: `await expectFocus(title)`.
 *
 * Focus is moved by an effect, a tick after the element is on the page, so a synchronous check
 * right after `findByRole` races it on a slow machine. The comparison is made to a boolean for
 * the reason given at {@link openDialogs}: a failed matcher must never format an element.
 *
 * @param element - The element that should hold focus.
 * @returns When it does; rejects at `waitFor`'s timeout otherwise.
 */
export async function expectFocus(element: Element | null): Promise<void> {
  await waitFor(() => expect(document.activeElement === element).toBe(true))
}

/**
 * Assert that a query found nothing: `expectAbsent(screen.queryByRole('button', { name }))`.
 *
 * Never `expect(screen.queryBy…(…)).toBeNull()`. That matcher fails exactly when it was given
 * an element, and then formats it, window and all (see {@link openDialogs}): the one failure
 * of this kind on CI took 22 seconds and wrote 290 MB before it said which button it had
 * found. Here the matcher sees a short description of the element, or `null`.
 *
 * @param element - What a `queryBy…` or `querySelector` returned.
 */
export function expectAbsent(element: Element | null): void {
  const found =
    element === null
      ? null
      : `<${element.tagName.toLowerCase()}> ${(element.textContent ?? '').trim().slice(0, 80)}`
  expect(found).toBeNull()
}

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
  /**
   * The client kind. Anything but `web` (the default) holds its own refresh token: the world
   * then gives it a token store, with a token in it when `signedIn`.
   */
  kind?: 'web' | 'server'
  /** The environment's password policy. */
  policy?: PasswordPolicy
  /** Whether a sign-up may leave the password out. */
  signUpPassword?: 'required' | 'optional'
  /** The environment's `mfa.policy`. Left out, the config says nothing (an older server). */
  mfaPolicy?: 'off' | 'optional' | 'required'
  /** Storage shared by the browser's tabs; without it an emailed link cannot be used. */
  linkStorage?: FakeLinkStorage
  /** The tab's `sessionStorage`: where an OAuth round trip's binding is kept. */
  tabStorage?: FakeLinkStorage
  /** The OAuth providers the environment has enabled. */
  oauth?: string[]
  /** The sign-in methods the environment has enabled. Left out: the password alone. */
  methods?: string[]
  /** The browser's WebAuthn globals; without them the browser cannot use passkeys. */
  passkeys?: PasskeyGlobals
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
  const web = options.kind !== 'server'
  const storage = memoryStorage()
  if (!web && options.signedIn) {
    void storage.set(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`, 'rt_0')
  }
  api.on(ROUTE.refresh, () =>
    options.signedIn
      ? json(200, sessionTokens('access_1', web ? {} : { refreshToken: 'rt_1' }))
      : failure(401, 'auth.unauthenticated')
  )
  api.on(ROUTE.me, () => json(200, TEST_USER))
  api.on(ROUTE.config, () =>
    json(200, {
      app: { name: 'Northline', supportEmail: null },
      signIn: {
        methods: options.methods ?? ['password'],
        ...(options.oauth && { oauth: options.oauth }),
      },
      signUp: { password: options.signUpPassword ?? 'required' },
      password: options.policy ?? PASSWORD_POLICY_PRESETS.recommended,
      ...(options.mfaPolicy && { mfa: { policy: options.mfaPolicy } }),
    })
  )
  api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
  const client = createClient(
    {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      fetch: api.fetch,
      ...(web ? { client: 'web' as const } : { client: 'server' as const, storage }),
    },
    fakeEnvironment(manualClock(), {
      linkStorage: options.linkStorage,
      tabStorage: options.tabStorage,
      page: options.page,
      timers: options.timers,
      passkeys: options.passkeys,
    })
  )
  return {
    api,
    client,
    // No pause between keys. user-event's default (`delay: 0`) waits for a timer after every
    // keystroke: a turn of the event loop each, which is most of what typing costs here and,
    // on a CI runner busy with the other packages' tests, tens of milliseconds a key. Nothing
    // under test needs the pause: every event is dispatched inside `act`, so React has
    // rendered before the next key (`harness.test.tsx` holds this).
    user: userEvent.setup({ delay: null }),
    mount: (ui, provider = {}) =>
      render(
        <TulaProvider client={client} {...(provider as object)}>
          {ui}
        </TulaProvider>
      ),
  }
}
