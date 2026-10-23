import { createTulaClientWithEnvironment, type TulaClient } from '@tula-tech/core'
import {
  createSandboxEnvironment,
  type PasskeySheetRequest,
  type SandboxAuthenticator,
  type VirtualPage,
} from './environment'
import {
  createSandboxFetch,
  SANDBOX_BASE_URL,
  SANDBOX_PUBLISHABLE_KEY,
  type SandboxFetchOptions,
} from './fetch'
import type { SandboxSettings } from './types'
import { createWorld, DEMO_EMAIL, DEMO_PASSWORD, type World } from './world'

export { UNSUPPORTED } from './handlers'
export {
  approveOAuth,
  attemptOfAuthorizationUrl,
  denyOAuth,
  PROVIDER_NAMES,
  pendingOAuth,
  sandboxProfiles,
} from './oauth'
export { totpNow } from './totp'
export * from './types'
export {
  createWorld,
  DEMO_EMAIL,
  DEMO_MFA_EMAIL,
  DEMO_PASSWORD,
  DEMO_TOTP_SECRET,
  type World,
} from './world'
export type { PasskeySheetRequest, SandboxAuthenticator, VirtualPage }
export { SANDBOX_BASE_URL, SANDBOX_PUBLISHABLE_KEY }

/** Options of {@link createSandbox}. */
export interface SandboxOptions {
  settings: SandboxSettings
  /** The page's address: its origin is where redirect URLs must be. */
  pageUrl: string
  /** The clock (tests). */
  now?: () => number
  /** Called with a URL the client sends the page to (a provider's authorization URL). */
  onNavigate?: (url: string) => void
  /** Called for a passkey sheet; the default approves. */
  confirmPasskey?: (request: PasskeySheetRequest) => Promise<boolean>
  /** A pause before each answer. */
  latencyMs?: SandboxFetchOptions['latencyMs']
}

/** A running sandbox: the API, the client that talks to it, and the device it runs on. */
export interface Sandbox {
  world: World
  /** The real `@tula-tech/core` client, on the sandbox's fetch and environment. */
  client: TulaClient
  page: VirtualPage
  authenticator: SandboxAuthenticator
  /** The sandbox's `fetch`, for a test that wants to call a route directly. */
  fetch: (request: Request) => Promise<Response>
  /**
   * Another browser on the same service: a second client with its own storage, so a link
   * opened there proves nothing about the sign-in the first one started.
   *
   * @param pageUrl - The address that browser is on (an emailed link).
   * @returns Its client and page.
   */
  another(pageUrl: string): { client: TulaClient; page: VirtualPage }
  /** Sign the demo account in through the real flow, whatever methods are switched on. */
  signInAsDemo(): Promise<void>
}

/**
 * Start a sandbox.
 *
 * @param options - Its settings, its page, and what navigation and the passkey sheet do.
 * @returns The world, a real client wired to it, the page and the simulated authenticator.
 *
 * @example
 * ```ts
 * const sandbox = createSandbox({ settings: DEFAULT_SANDBOX_SETTINGS, pageUrl: 'http://localhost/playground/' })
 * const flow = await sandbox.client.signIn.create({ identifier: 'ada@example.test' })
 * ```
 */
export function createSandbox(options: SandboxOptions): Sandbox {
  const world = createWorld({
    settings: options.settings,
    redirectOrigin: new URL(options.pageUrl).origin,
    ...(options.now && { now: options.now }),
  })
  const { environment, page, authenticator } = createSandboxEnvironment({
    now: world.now,
    pageUrl: options.pageUrl,
    onNavigate: options.onNavigate ?? (() => {}),
    confirmPasskey: options.confirmPasskey ?? (async () => true),
  })
  const fetch = createSandboxFetch(world, { latencyMs: options.latencyMs ?? 0 })
  const client = createTulaClientWithEnvironment(
    {
      publishableKey: SANDBOX_PUBLISHABLE_KEY,
      baseUrl: SANDBOX_BASE_URL,
      client: 'web',
      fetch,
    },
    environment
  )
  const signInAsDemo = async () => {
    // The real flow, with the password on and no second step for this one call, so that the
    // account screen can be shown whatever the visitor has switched off. The settings return.
    const settings = world.settings
    world.configure({
      ...settings,
      methods: { ...settings.methods, password: true },
      mfaPolicy: 'off',
    })
    try {
      const flow = await client.signIn.start({ identifier: DEMO_EMAIL })
      await flow.submitPassword({ password: DEMO_PASSWORD })
    } finally {
      world.configure(settings)
    }
  }
  const another = (pageUrl: string) => {
    const other = createSandboxEnvironment({
      now: world.now,
      pageUrl,
      onNavigate: () => {},
      confirmPasskey: async () => false,
    })
    const otherClient = createTulaClientWithEnvironment(
      {
        publishableKey: SANDBOX_PUBLISHABLE_KEY,
        baseUrl: SANDBOX_BASE_URL,
        client: 'web',
        fetch,
      },
      other.environment
    )
    return { client: otherClient, page: other.page }
  }
  return { world, client, page, authenticator, fetch, another, signInAsDemo }
}
