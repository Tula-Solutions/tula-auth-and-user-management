import type { Schemas } from './api-types'

/** An OAuth provider the sandbox can draw a consent screen for. */
export type SandboxProvider = Schemas['OAuthProvider']

/** The providers the sandbox knows, in the order the panel lists them. */
export const SANDBOX_PROVIDERS: readonly SandboxProvider[] = [
  'google',
  'github',
  'apple',
  'microsoft',
  'discord',
  'linkedin',
  'x',
  'facebook',
]

/** Two-step verification policy, as the contract names it. */
export type SandboxMfaPolicy = Schemas['MfaPolicy']

/**
 * What the sandbox environment is set to: the part of an environment's settings a visitor can
 * change in the playground. The same shape `tula.config.ts` writes (see `code.ts`), reduced to
 * the keys the sandbox acts on.
 *
 * @example
 * ```ts
 * const settings: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS, mfaPolicy: 'required' }
 * ```
 */
export interface SandboxSettings {
  /** The app's name, shown in the card and in emails. */
  appName: string
  /** The first-factor methods that are switched on. `emailLink` needs `emailCode`. */
  methods: {
    password: boolean
    emailCode: boolean
    emailLink: boolean
    passkey: boolean
  }
  /** The OAuth providers that are switched on. */
  oauth: SandboxProvider[]
  /** Whether a sign-up must choose a password. */
  signUpPassword: 'required' | 'optional'
  /** Whether two-step verification is off, offered or required. */
  mfaPolicy: SandboxMfaPolicy
  /**
   * Whether organizations are on (ADR 0065): users may create them, belong to several and
   * switch between them. The sandbox keeps the personal account and user-created organizations
   * on whenever this is.
   */
  organizations: boolean
}

/** The sandbox's default environment: the password and emailed codes. */
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  appName: 'Acme',
  methods: { password: true, emailCode: false, emailLink: false, passkey: false },
  oauth: [],
  signUpPassword: 'required',
  mfaPolicy: 'optional',
  organizations: false,
}

/** An account of the sandbox. Fake, and held in memory only. */
export interface SandboxUser {
  id: string
  email: string
  /** The plain password: a sandbox holds no real secret, and says so. */
  password: string | null
  firstName: string | null
  lastName: string | null
  emailVerifiedAt: string | null
  createdAt: string
  lastSignInAt: string | null
  /** A confirmed (or pending) authenticator app. */
  totp: { secret: string; confirmedAt: string | null } | null
  backupCodes: string[]
  passkeys: SandboxPasskey[]
  identities: { id: string; provider: string; subject: string; createdAt: string }[]
}

/** A passkey registered with the sandbox's simulated authenticator. */
export interface SandboxPasskey {
  id: string
  /** The credential id the simulated authenticator holds. */
  credentialId: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

/** A session of the sandbox. */
export interface SandboxSession {
  id: string
  userId: string
  client: Schemas['SessionClient']
  createdAt: number
  lastActiveAt: number
  expiresAt: number
  /** The current refresh token. Opaque, and meaningless outside the sandbox. */
  refreshToken: string
  amr: string[]
  /** The organization the session acts in (`org_id` of its access token), or the personal account. */
  organizationId: string | null
}

/** A role the sandbox's organizations have: the contract's two built-in ones. */
export type SandboxRole = 'admin' | 'member'

/** An organization of the sandbox, with everything that belongs to it. */
export interface SandboxOrganization {
  id: string
  name: string
  slug: string
  createdAt: string
  members: SandboxMember[]
  invitations: SandboxInvitation[]
  domains: SandboxDomain[]
}

/** A user's membership of a sandbox organization. */
export interface SandboxMember {
  userId: string
  role: SandboxRole
  createdAt: string
}

/** An invitation to a sandbox organization. */
export interface SandboxInvitation {
  id: string
  /** The address it was sent to. */
  email: string
  role: SandboxRole
  status: Schemas['OrganizationInvitation']['status']
  invitedBy: string | null
  expiresAt: string
  createdAt: string
  /** What the emailed link carries. Opaque, and meaningless outside the sandbox. */
  token: string
}

/** An email domain an organization claims. */
export interface SandboxDomain {
  id: string
  domain: string
  mode: Schemas['OrganizationDomainMode']
  /** The code emailed to the claim's address, until the domain is verified. */
  code: string | null
  codeExpiresAt: number | null
  /** Wrong guesses so far. */
  tries: number
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

/** The steps an attempt can wait on. */
export type AttemptStatus = Exclude<Schemas['FlowStep']['status'], 'needs_identifier'>

/** What the sandbox emailed. */
export interface SandboxEmail {
  id: string
  to: string
  subject: string
  /** The message, in text. */
  text: string
  /** The six-digit code the email carries, when it carries one. */
  code?: string
  /** The sign-in link the email carries, when it carries one. */
  link?: string
  /** When it was "sent", epoch milliseconds. */
  sentAt: number
  /** Whether the code and link are past their time. */
  expired: boolean
  /** Whether the message is a notice with no code, such as the one an unknown address gets. */
  notice: boolean
}

/** A code or link the server is waiting for. */
export interface PendingVerification {
  code: string
  linkToken: string | null
  expiresAt: number
  /** Wrong guesses so far. */
  tries: number
  emailId: string
  /** A decoy belongs to an address with no account: it answers like a wrong code. */
  decoy: boolean
}

/** One flow attempt of the sandbox. */
export interface SandboxAttempt {
  id: string
  secret: string
  kind: Schemas['FlowKind']
  expiresAt: number
  status: AttemptStatus | 'complete'
  strategies: Schemas['FirstFactorStrategy'][]
  identifier: string
  /** The account, once a factor named it. */
  userId: string | null
  /** What the attempt has proven, as the session's `amr`. */
  proven: string[]
  /** A sign-up's details, kept until the address is proven. */
  signUp: { password: string | null; firstName: string | null; lastName: string | null } | null
  verification: PendingVerification | null
  linkBinding: string | null
  linkVerified: boolean
  /** Where an emailed link leads. */
  linkRedirectUrl: string | null
  /** Waiting on a second factor: what the user may prove. */
  secondFactors: Schemas['SecondFactorMethod'][]
  /** An authenticator app being enrolled inside the attempt. */
  enrolmentSecret: string | null
  /** The first factor an emailed message was asked for. */
  prepared: Schemas['PreparedFirstFactorStrategy'] | null
  oauth: {
    provider: SandboxProvider
    redirectUrl: string
    binding: string
    intent: 'sign_in' | 'link'
    /** The signed-in user a link was started by. */
    linkUserId: string | null
    /** What the provider's page answered, once it did. */
    result: { ticket: string; expiresAt: number; profile: OAuthProfile; used: boolean } | null
  } | null
  sessionId: string | null
  /** The password was proven (so a reset or expiry does not apply). */
  passwordProven: boolean
}

/** What a sandbox provider tells the service about the person who approved. */
export interface OAuthProfile {
  /** The provider's stable id for the person. */
  subject: string
  email: string
  name: string
}

/** What the sandbox tells a UI about a pending provider round trip. */
export interface OAuthRequest {
  attemptId: string
  provider: SandboxProvider
  redirectUrl: string
}
