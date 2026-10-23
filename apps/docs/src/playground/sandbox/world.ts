import type { Schemas } from './api-types'
import { SandboxError } from './errors'
import { base32Encode } from './totp'
import {
  DEFAULT_SANDBOX_SETTINGS,
  type SandboxAttempt,
  type SandboxCustomRole,
  type SandboxEmail,
  type SandboxOrganization,
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

/**
 * The custom roles (ADR 0065, "Custom roles") the sandbox's environment defines, beside the
 * built-in `admin` and `member`: one that can read the member list and invite, nothing more.
 * Anyone with `org:sys:invitations:manage` may offer a role that holds no more than they do, as
 * on the real server.
 */
export const SANDBOX_CUSTOM_ROLES: readonly SandboxCustomRole[] = [
  {
    key: 'support',
    name: 'Support',
    permissions: ['org:sys:memberships:read', 'org:sys:invitations:manage'],
  },
]

/**
 * How many organizations one user may create through the client in the sandbox
 * (`organizations.maxCreatedPerUser`; the real default is 5). Low enough to meet
 * `organization.limit_reached` by hand.
 */
export const SANDBOX_MAX_CREATED_PER_USER = 3

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
  /**
   * The one origin a redirect URL may have (the environment's allowed redirect URLs, as the
   * generated config shows them). Without it any address is accepted, as in a unit test.
   */
  redirectOrigin?: string
}

/** The sandbox's state and the few operations on it that more than one route needs. */
export interface World {
  now(): number
  settings: SandboxSettings
  /** See `WorldOptions.redirectOrigin`. */
  redirectOrigin: string | null
  users: Map<string, SandboxUser>
  attempts: Map<string, SandboxAttempt>
  sessions: Map<string, SandboxSession>
  /** The organizations, by id (ADR 0065). */
  organizations: Map<string, SandboxOrganization>
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
 * The token of the invitation to "Hooli" the sandbox starts with, sent to `DEMO_EMAIL`. The
 * playground's organization switcher is given it the way an app is given the token of the
 * page an emailed link leads to.
 */
export const DEMO_INVITATION_TOKEN = 'sbx-invitation-token-hooli'

/** The organizations the sandbox starts with: three the demo accounts belong to, one to join. */
function seedOrganizations(world: Pick<World, 'organizations' | 'now'>): void {
  const day = 24 * 60 * 60_000
  const created = new Date(world.now() - 20 * day).toISOString()
  const make = (
    id: string,
    name: string,
    members: [string, 'admin' | 'member'][],
    extra: Partial<SandboxOrganization> = {}
  ) => {
    world.organizations.set(id, {
      id,
      name,
      slug: name.toLowerCase(),
      createdAt: created,
      members: members.map(([userId, role]) => ({ userId, role, createdAt: created })),
      invitations: [],
      domains: [],
      createdBy: null,
      ...extra,
    })
  }
  make('0198a000-0000-7000-8000-000000000001', 'Acme', [
    ['usr_sandbox_ada', 'admin'],
    ['usr_sandbox_grace', 'member'],
  ])
  make('0198a000-0000-7000-8000-000000000002', 'Globex', [
    ['usr_sandbox_ada', 'member'],
    ['usr_sandbox_grace', 'admin'],
  ])
  // A verified domain the demo account's address is on, so that Initech is offered to Ada.
  make('0198a000-0000-7000-8000-000000000003', 'Initech', [['usr_sandbox_grace', 'admin']], {
    domains: [
      {
        id: '0198a000-0000-7000-8000-0000000000d1',
        domain: 'example.test',
        mode: 'suggest',
        code: null,
        codeExpiresAt: null,
        tries: 0,
        verifiedAt: created,
        createdAt: created,
        updatedAt: created,
      },
    ],
  })
  make('0198a000-0000-7000-8000-000000000004', 'Hooli', [['usr_sandbox_grace', 'admin']], {
    invitations: [
      {
        id: '0198a000-0000-7000-8000-0000000000e1',
        email: DEMO_EMAIL,
        role: 'member',
        status: 'pending',
        invitedBy: 'usr_sandbox_grace',
        expiresAt: new Date(world.now() + 7 * day).toISOString(),
        createdAt: created,
        token: DEMO_INVITATION_TOKEN,
      },
    ],
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
    redirectOrigin: options.redirectOrigin ?? null,
    users: new Map(),
    attempts: new Map(),
    sessions: new Map(),
    organizations: new Map(),
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
      world.organizations.clear()
      world.inbox.length = 0
      world.lockouts.clear()
      world.usedTotpSteps.clear()
      world.retiredTokens.clear()
      world.cookie.refreshToken = null
      seedUsers(world)
      seedOrganizations(world)
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
        organizationId: null,
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
  seedOrganizations(world)
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
