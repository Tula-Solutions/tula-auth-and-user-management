import type { Schemas } from './api-types'
import { SandboxError } from './errors'
import { base32Encode } from './totp'
import {
  DEFAULT_SANDBOX_SETTINGS,
  type SandboxAttempt,
  type SandboxEmail,
  type SandboxSession,
  type SandboxSettings,
  type SandboxUser,
} from './types'

// The sandbox's state: fake users, attempts, sessions and the inbox, all in memory, all gone
// when the page is. Nothing here is a service: it is the data the in-browser API (`handlers.ts`)
// answers from. The numbers below are the real service's where a visitor can see them (a code
// lives ten minutes and allows five guesses); the lockout is shortened so that it can be seen.

/** How long an attempt, a code and an emailed link live. */
export const ATTEMPT_TTL_MS = 10 * 60_000
/** Wrong guesses a code allows. */
export const CODE_GUESSES = 5
/** Wrong passwords for one identifier before the sandbox asks it to wait. */
export const LOCKOUT_FAILURES = 5
/** How long the (simulated) lockout lasts. The real one backs off; this one is short on purpose. */
export const LOCKOUT_SECONDS = 20
/** The lifetime of an access token. */
export const ACCESS_TOKEN_TTL_MS = 60_000
/** The lifetime of a session. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000

/** The password policy the sandbox's environment holds: the contract's `recommended` preset. */
export const SANDBOX_PASSWORD_POLICY: Schemas['PasswordPolicy'] = {
  preset: 'recommended',
  minLength: 10,
  maxLength: 128,
  requireLowercase: false,
  requireUppercase: false,
  requireNumber: false,
  requireSpecial: false,
  minCharacterClasses: 0,
  specialChars: '!@#$%^&*()-_=+[]{};:,.?/\\|\'"`~<>',
  disallowUserInfo: true,
  disallowCommon: true,
  breachCheck: 'block',
  maxRepeatedChars: null,
  blockSequences: false,
  history: 0,
  expiryDays: null,
}

/** The demo accounts the sandbox starts with, and their shared password. */
export const DEMO_PASSWORD = 'Sandbox-pass-42!'
/** An account with no second factor. */
export const DEMO_EMAIL = 'ada@example.test'
/** An account with an authenticator app. */
export const DEMO_MFA_EMAIL = 'grace@example.test'
/** The demo authenticator app's secret: Base32, as an app would show it. */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

/** Options of {@link createWorld}. */
export interface WorldOptions {
  /** The clock. Defaults to `Date.now`. */
  now?: () => number
  /** The environment's settings. */
  settings?: SandboxSettings
}

/** The sandbox's state and the few operations on it that more than one route needs. */
export interface World {
  now(): number
  settings: SandboxSettings
  users: Map<string, SandboxUser>
  attempts: Map<string, SandboxAttempt>
  sessions: Map<string, SandboxSession>
  /** The browser's cookie jar, as far as the sandbox is concerned: the web client's session. */
  cookie: { refreshToken: string | null }
  inbox: SandboxEmail[]
  /** Wrong-password counters per identifier. */
  lockouts: Map<string, { failures: number; until: number }>
  /** Spent TOTP steps per user, so a code is accepted once. */
  usedTotpSteps: Map<string, number>
  /** Refresh tokens that were rotated, and the session each belonged to (reuse detection). */
  retiredTokens: Map<string, string>
  /** Listeners told when the inbox or the signed-in state changes. */
  subscribe(listener: () => void): () => void
  changed(): void
  id(prefix: string): string
  secret(bytes?: number): string
  digits(): string
  /** Replace the settings (the config panel). Attempts already started keep what they offered. */
  configure(settings: SandboxSettings): void
  /** Forget everything and start again with the demo accounts. */
  reset(): void
  /** Put an email in the inbox. */
  sendEmail(email: Omit<SandboxEmail, 'id' | 'sentAt' | 'expired'>): SandboxEmail
  findUserByEmail(email: string): SandboxUser | undefined
  /** Start a session for a user. */
  createSession(user: SandboxUser, client: Schemas['SessionClient'], amr: string[]): SandboxSession
  /** Count a wrong password (or code) for an identifier, and refuse once it is locked. */
  countFailure(identifier: string): void
  /** Refuse an identifier that is locked out. */
  assertNotLocked(identifier: string): void
  clearFailures(identifier: string): void
}

/**
 * The normal form of an email address: trimmed and lower-case.
 *
 * @param email - What was typed.
 * @returns The key the sandbox looks accounts up by.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Mask an address the way the real service does in a step: the first letter, then dots.
 *
 * @param email - The address.
 * @returns For example `a•••@example.test`.
 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}•••@${domain}`
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function seedUsers(world: Pick<World, 'users' | 'now'>): void {
  const created = new Date(world.now() - 30 * 24 * 60 * 60_000).toISOString()
  const base = {
    password: DEMO_PASSWORD,
    emailVerifiedAt: created,
    createdAt: created,
    lastSignInAt: null,
    passkeys: [],
    identities: [],
  }
  world.users.set('usr_sandbox_ada', {
    ...base,
    id: 'usr_sandbox_ada',
    email: DEMO_EMAIL,
    firstName: 'Ada',
    lastName: 'Lovelace',
    totp: null,
    backupCodes: [],
  })
  world.users.set('usr_sandbox_grace', {
    ...base,
    id: 'usr_sandbox_grace',
    email: DEMO_MFA_EMAIL,
    firstName: 'Grace',
    lastName: 'Hopper',
    totp: { secret: DEMO_TOTP_SECRET, confirmedAt: created },
    backupCodes: ['sbx1-aaaa', 'sbx1-bbbb', 'sbx1-cccc', 'sbx1-dddd'],
  })
}

/**
 * Make a sandbox world.
 *
 * @param options - A clock and settings, both for tests.
 * @returns The world, with the demo accounts `ada@example.test` and `grace@example.test`
 *   (who has an authenticator app) in it.
 *
 * @example
 * ```ts
 * const world = createWorld()
 * world.findUserByEmail('ada@example.test')?.firstName // 'Ada'
 * ```
 */
export function createWorld(options: WorldOptions = {}): World {
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<() => void>()
  let counter = 0
  const world: World = {
    now,
    settings: options.settings ?? DEFAULT_SANDBOX_SETTINGS,
    users: new Map(),
    attempts: new Map(),
    sessions: new Map(),
    cookie: { refreshToken: null },
    inbox: [],
    lockouts: new Map(),
    usedTotpSteps: new Map(),
    retiredTokens: new Map(),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changed() {
      for (const listener of listeners) {
        listener()
      }
    },
    id(prefix) {
      counter += 1
      return `${prefix}_sbx_${hex(randomBytes(6))}${counter.toString(36)}`
    },
    secret(bytes = 24) {
      return hex(randomBytes(bytes))
    },
    digits() {
      const value = new DataView(randomBytes(4).buffer).getUint32(0) % 1_000_000
      return String(value).padStart(6, '0')
    },
    configure(settings) {
      world.settings = settings
      world.changed()
    },
    reset() {
      world.users.clear()
      world.attempts.clear()
      world.sessions.clear()
      world.inbox.length = 0
      world.lockouts.clear()
      world.usedTotpSteps.clear()
      world.retiredTokens.clear()
      world.cookie.refreshToken = null
      seedUsers(world)
      world.changed()
    },
    sendEmail(email) {
      const sent: SandboxEmail = {
        ...email,
        id: world.id('eml'),
        sentAt: now(),
        expired: false,
      }
      world.inbox.push(sent)
      world.changed()
      return sent
    },
    findUserByEmail(email) {
      const wanted = normalizeEmail(email)
      return [...world.users.values()].find((user) => normalizeEmail(user.email) === wanted)
    },
    createSession(user, client, amr) {
      const at = now()
      const session: SandboxSession = {
        id: world.id('ses'),
        userId: user.id,
        client,
        createdAt: at,
        lastActiveAt: at,
        expiresAt: at + SESSION_TTL_MS,
        refreshToken: `sbx_rt_${world.secret(24)}`,
        amr,
      }
      world.sessions.set(session.id, session)
      user.lastSignInAt = new Date(at).toISOString()
      return session
    },
    countFailure(identifier) {
      const key = normalizeEmail(identifier)
      const entry = world.lockouts.get(key) ?? { failures: 0, until: 0 }
      entry.failures += 1
      if (entry.failures >= LOCKOUT_FAILURES) {
        entry.until = now() + LOCKOUT_SECONDS * 1000
      }
      world.lockouts.set(key, entry)
    },
    assertNotLocked(identifier) {
      const entry = world.lockouts.get(normalizeEmail(identifier))
      if (entry && entry.until > now()) {
        throw new SandboxError('rate_limited', {
          retryAfterSeconds: Math.max(1, Math.ceil((entry.until - now()) / 1000)),
        })
      }
      if (entry && entry.until !== 0 && entry.until <= now()) {
        world.lockouts.delete(normalizeEmail(identifier))
      }
    },
    clearFailures(identifier) {
      world.lockouts.delete(normalizeEmail(identifier))
    },
  }
  seedUsers(world)
  return world
}

/**
 * A fresh Base32 secret for an authenticator app.
 *
 * @returns Thirty-two characters, as an authenticator app shows.
 */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}
