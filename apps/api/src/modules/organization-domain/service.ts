import {
  DOMAINS_MANAGE_PERMISSION,
  domainOfAddress,
  durationToMs,
  isPublicEmailDomain,
  MAX_DOMAINS_PER_ORGANIZATION,
  type OrganizationDomain,
  type OrganizationDomainList,
  type OrganizationDomainMode,
  type OrganizationSuggestion,
  type OrganizationSuggestionList,
  type StartOrganizationDomainRequest,
  type UserOrganization,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import {
  AuthError,
  ForbiddenError,
  InternalError,
  InvalidEmailError,
  NotFoundError,
  RateLimitError,
  ServiceException,
} from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomDigits, timingSafeEqual } from '~/lib/crypto'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import { describeMailFailure, errorReason } from '~/lib/safe-error'
import * as Audit from '~/modules/audit/service'
import * as Email from '~/modules/email/service'
import { requireEnabled, requireRole } from '~/modules/organization/service'
import * as Settings from '~/modules/settings/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import type { OrganizationDomainRecord } from '~/ports/organization-domain-store'
import type { OrganizationRecord } from '~/ports/organization-store'

// Verified domains of an organization (ADR 0065, "Verified domains"). An administrator claims
// a domain by entering a code emailed to an address on it; once verified, a user who signs up
// with a verified address on exactly that domain is joined to the organization (`auto_join`) or
// offered it (`suggest`, and for anyone who did not join at sign-up). A domain is verified for
// one organization per environment, and a public mail domain can never be claimed.

/** Digits in the emailed code. */
export const CODE_LENGTH = 6

/** How long a code stays valid. */
export const CODE_TTL = '10m'

/** Guesses one code allows (its own counter), beside the lockout. */
export const MAX_ATTEMPTS = 5

/**
 * Codes one organization may ask for in an hour, beside the one-a-minute cooldown. Counted per
 * organization: it is the administrator's account that is trusted to ask, and an organization
 * that sends this many is not claiming domains.
 */
export const CODES_PER_ORGANIZATION_PER_HOUR = 10

/**
 * Codes an environment sends in a day for domain claims, whoever asks. A cap on what this
 * feature can cost (mail) and be used for, set well above what real use needs.
 */
export const CODES_PER_ENVIRONMENT_PER_DAY = 200

/**
 * Codes one address may be sent in an hour. The address is chosen by the asker, so without
 * this a few organizations could fill a stranger's inbox.
 */
export const CODES_PER_ADDRESS_PER_HOUR = 5

/** Keyed-hash purpose of the codes. */
export const KEYED_HASH_PURPOSE = 'organization-domain-codes'

/** Keyed-hash purpose of the per-address limiter key (limiter keys may live in Redis). */
export const ADDRESS_LIMIT_HASH_PURPOSE = 'organization-domain-address-limits'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/** What the signed-in user's routes know of the caller. */
export interface Self {
  userId: string
}

/**
 * The lockout key of guesses at one claim's code: per environment and claim, so that asking
 * for a new code (which resets the row's own counter) does not reset the back-off, and so that
 * an organization's other claims are not held up by guesses at this one. Ids only: lockout
 * keys may live in Redis.
 *
 * @param environmentId - The environment.
 * @param domainId - The claim's row id.
 * @returns The key for `deps.lockout`.
 */
export function codeLockKey(environmentId: string, domainId: string): string {
  return `organization_domain_code:${environmentId}:${domainId}`
}

/**
 * The keyed hash a claim stores for its code. It covers the claim's row, the domain and the
 * code, so a code proves that domain for that row and nothing else, even if a stored hash
 * were moved.
 *
 * @param deps - The keyed hasher.
 * @param id - The claim's row id.
 * @param domain - The domain.
 * @param code - The 6-digit code.
 * @returns The HMAC, hex.
 */
export async function hashCode(
  deps: Pick<Deps, 'keyedHash'>,
  id: string,
  domain: string,
  code: string
): Promise<string> {
  return deps.keyedHash.hmac(KEYED_HASH_PURPOSE, `${id}:${domain}:${code}`)
}

/** The public view of a claim or a verified domain. Never the code or its hash. */
function view(record: OrganizationDomainRecord): OrganizationDomain {
  return {
    id: record.id,
    domain: record.domain,
    mode: record.mode,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    codeExpiresAt: record.verifiedAt ? null : (record.codeExpiresAt?.toISOString() ?? null),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/** The organization, or the 404 every route answers for one that is not this environment's. */
async function requireOrganization(
  deps: Pick<Deps, 'organizations'>,
  scope: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<OrganizationRecord> {
  const record = await deps.organizations.find(scope.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/** The claim, or the 404 for one the organization does not have. */
async function requireDomain(
  deps: Pick<Deps, 'organizationDomains'>,
  scope: Pick<Tenant, 'environmentId'>,
  organizationId: string,
  id: string
): Promise<OrganizationDomainRecord> {
  const record = await deps.organizationDomains.find(scope.environmentId, organizationId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/**
 * Let a signed-in user manage an organization's domains: a member whose role, **as stored now**,
 * holds `org:sys:domains:manage`. Never read from the token: a demotion takes effect at once.
 *
 * @param deps - The organization store.
 * @param scope - The environment.
 * @param self - The signed-in user.
 * @param organizationId - The organization.
 * @throws AuthError `organization.not_a_member` for a user who does not belong to it, and for
 *   an organization that does not exist or is another environment's alike.
 * @throws ForbiddenError (`auth.forbidden`) for a member without the permission.
 */
export async function requireManager(
  deps: Pick<Deps, 'organizations'>,
  scope: Pick<Tenant, 'environmentId'>,
  self: Self,
  organizationId: string
): Promise<void> {
  const held = await deps.organizations.findUserMembership(
    scope.environmentId,
    organizationId,
    self.userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  if (!held.permissions.includes(DOMAINS_MANAGE_PERMISSION)) {
    throw new ForbiddenError()
  }
}

/**
 * The checks every client route makes first: organizations are switched on, and the caller
 * may manage the organization's domains ({@link requireManager}). In that order, so a disabled
 * environment answers `organization.disabled` whoever asks.
 *
 * @param deps - The organization store, settings and config.
 * @param scope - The environment.
 * @param self - The signed-in user.
 * @param organizationId - The organization.
 * @throws AuthError `organization.disabled`, `organization.not_a_member`.
 * @throws ForbiddenError (`auth.forbidden`) for a member without the permission.
 */
export async function requireEnabledManager(
  deps: Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>,
  scope: Pick<Tenant, 'environmentId'>,
  self: Self,
  organizationId: string
): Promise<void> {
  await requireEnabled(deps, scope)
  await requireManager(deps, scope, self, organizationId)
}

/**
 * List an organization's domains, oldest first: claims waiting for a code and verified ones.
 *
 * @param deps - Stores and settings.
 * @param scope - The environment.
 * @param organizationId - The organization.
 * @returns The domains.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 * @throws NotFoundError when the environment has no such organization.
 */
export async function list(
  deps: Pick<Deps, 'organizations' | 'organizationDomains' | 'environmentSettings' | 'config'>,
  scope: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<OrganizationDomainList> {
  await requireEnabled(deps, scope)
  await requireOrganization(deps, scope, organizationId)
  const records = await deps.organizationDomains.list(scope.environmentId, organizationId)
  return { data: records.map(view) }
}

type StartDeps = Pick<
  Deps,
  | 'organizations'
  | 'organizationDomains'
  | 'environmentSettings'
  | 'config'
  | 'ids'
  | 'clock'
  | 'keyedHash'
  | 'rateLimiter'
  | 'mailer'
>

/** Count a send under a limit, or refuse it. */
async function hit(
  deps: Pick<Deps, 'rateLimiter'>,
  key: string,
  limit: number,
  window: string
): Promise<void> {
  // A limiter that cannot answer throws (ServiceUnavailableError): nothing is sent.
  const decision = await deps.rateLimiter.hit(key, limit, durationToMs(window))
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterMs)
  }
}

/**
 * Claim a domain for an organization: email a 6-digit code to an address **on that domain**
 * and keep a pending claim that the code verifies. Asked again for a pending claim, it emails
 * a new code (the old one stops working) and may change the mode. Nothing is granted until
 * {@link verify}.
 *
 * Refused before anything is sent: a public mail domain (`organization.domain_public`), an
 * address that is not, exactly, on the domain (`organization.domain_address_mismatch`: a
 * subdomain is another domain), a domain that is verified already, for this organization or
 * another (`organization.domain_taken`), and an organization at its domain limit.
 *
 * Sends are limited per organization (one a minute and {@link CODES_PER_ORGANIZATION_PER_HOUR}
 * an hour), per environment ({@link CODES_PER_ENVIRONMENT_PER_DAY} a day) and per address
 * ({@link CODES_PER_ADDRESS_PER_HOUR} an hour, under a keyed hash). The code is stored as a
 * keyed hash that also covers the claim's id and the domain, and never as the code.
 *
 * @param deps - Stores, settings, ids, clock, keyed hash, rate limiter and mailer.
 * @param scope - The project and environment.
 * @param organizationId - The organization.
 * @param input - The domain, an address on it, and the mode.
 * @param actor - Who asks, for the audit log.
 * @returns The pending claim.
 * @throws AuthError `organization.disabled`, `organization.domain_public`,
 *   `organization.domain_address_mismatch`, `organization.domain_taken`,
 *   `organization.domain_limit`.
 * @throws InvalidEmailError for what is not an address.
 * @throws NotFoundError when the environment has no such organization.
 * @throws RateLimitError when a send limit is spent.
 * @throws ServiceUnavailableError when the rate limiter cannot answer (nothing is sent).
 * @throws InternalError when the email could not be sent.
 */
export async function start(
  deps: StartDeps,
  scope: Scope,
  organizationId: string,
  input: StartOrganizationDomainRequest,
  actor: Actor
): Promise<OrganizationDomain> {
  await requireEnabled(deps, scope)
  await requireOrganization(deps, scope, organizationId)
  const { domain } = input
  if (isPublicEmailDomain(domain)) {
    throw new AuthError('organization.domain_public')
  }
  const address = parseEmail(input.email)
  if (!address) {
    throw new InvalidEmailError()
  }
  // Exactly the domain: `a@mail.acme.com` is not on `acme.com`.
  if (domainOfAddress(address.normalized) !== domain) {
    throw new AuthError('organization.domain_address_mismatch')
  }
  if (await deps.organizationDomains.findVerified(scope.environmentId, domain)) {
    throw new AuthError('organization.domain_taken')
  }
  const held = await deps.organizationDomains.list(scope.environmentId, organizationId)
  const existing = held.find((one) => one.domain === domain)
  if (!existing && held.length >= MAX_DOMAINS_PER_ORGANIZATION) {
    throw new AuthError('organization.domain_limit', { max: MAX_DOMAINS_PER_ORGANIZATION })
  }

  const subject = `${scope.environmentId}:${organizationId}`
  await hit(deps, `organization_domain_cooldown:${subject}`, 1, '1m')
  await hit(deps, `organization_domain:${subject}`, CODES_PER_ORGANIZATION_PER_HOUR, '1h')
  await hit(
    deps,
    `organization_domain_environment:${scope.environmentId}`,
    CODES_PER_ENVIRONMENT_PER_DAY,
    '1d'
  )
  const hashedAddress = await deps.keyedHash.hmac(
    ADDRESS_LIMIT_HASH_PURPOSE,
    `${scope.environmentId}:${address.normalized}`
  )
  await hit(
    deps,
    `organization_domain_address:${scope.environmentId}:${hashedAddress}`,
    CODES_PER_ADDRESS_PER_HOUR,
    '1h'
  )

  const id = existing?.id ?? deps.ids.next()
  const code = randomDigits(CODE_LENGTH)
  // Send first: a relay that fails stores nothing, and an earlier code keeps working.
  try {
    await Email.send(deps, scope, address.email, {
      type: 'organization_domain_verification',
      code,
      ttlMinutes: durationToMs(CODE_TTL) / 60_000,
    })
  } catch (error) {
    if (error instanceof ServiceException) {
      throw error
    }
    throw new InternalError({
      internalMessage: `domain verification email could not be sent (${describeMailFailure(error)})`,
    })
  }
  const at = deps.clock.now()
  const result = await deps.organizationDomains.claim(
    {
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      organizationId,
      domain,
      mode: input.mode,
      codeHash: await hashCode(deps, id, domain, code),
      codeExpiresAt: new Date(at.getTime() + durationToMs(CODE_TTL)),
      at,
      limit: MAX_DOMAINS_PER_ORGANIZATION,
    },
    Audit.entry(deps, scope, {
      type: 'organization_domain.claimed',
      actor,
      target: { type: 'organization_domain', id },
      data: { organizationId, domain, mode: input.mode },
    })
  )
  switch (result.outcome) {
    case 'claimed':
      return view(result.record)
    case 'taken':
      throw new AuthError('organization.domain_taken')
    case 'limit_reached':
      throw new AuthError('organization.domain_limit', { max: MAX_DOMAINS_PER_ORGANIZATION })
    case 'gone':
      throw new NotFoundError()
  }
}

type VerifyDeps = Pick<
  Deps,
  | 'organizations'
  | 'organizationDomains'
  | 'environmentSettings'
  | 'config'
  | 'ids'
  | 'clock'
  | 'keyedHash'
  | 'lockout'
>

/**
 * Verify a claimed domain with the code emailed to an address on it.
 *
 * In order: the claim must exist (404); a claim already verified answers as it is;
 * with no live code (never sent, expired, or out of guesses) there is nothing to guess at:
 * `verification.expired`, nothing counted; the guess is counted under the claim's
 * {@link codeLockKey} (`CREDENTIAL_LOCKOUT`) **before** the code is looked at, and again by the
 * row's own counter ({@link MAX_ATTEMPTS} guesses per code); a wrong code is
 * `verification.invalid_code`; the right one verifies in one write that only succeeds while
 * the row still holds that code, and in which the database's unique key over verified domains
 * decides a race between organizations. A success clears the lockout.
 *
 * @param deps - Stores, settings, ids, clock, keyed hash and lockout.
 * @param scope - The project and environment.
 * @param organizationId - The organization.
 * @param domainId - The claim.
 * @param code - The presented code.
 * @param actor - Who verifies, for the audit log.
 * @returns The verified domain.
 * @throws AuthError `organization.disabled`, `organization.domain_public` (the public list
 *   grew since the claim), `organization.domain_taken`, `verification.expired`,
 *   `verification.invalid_code`, `verification.too_many_attempts`.
 * @throws NotFoundError when the organization or the claim does not exist.
 * @throws RateLimitError while the claim is locked out after repeated wrong codes.
 */
export async function verify(
  deps: VerifyDeps,
  scope: Scope,
  organizationId: string,
  domainId: string,
  code: string,
  actor: Actor
): Promise<OrganizationDomain> {
  await requireEnabled(deps, scope)
  await requireOrganization(deps, scope, organizationId)
  const claim = await requireDomain(deps, scope, organizationId, domainId)
  if (claim.verifiedAt !== null) {
    return view(claim)
  }
  const now = deps.clock.now()
  if (
    claim.codeHash === null ||
    claim.codeExpiresAt === null ||
    claim.codeExpiresAt.getTime() <= now.getTime()
  ) {
    throw new AuthError('verification.expired')
  }
  const lockKey = codeLockKey(scope.environmentId, claim.id)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, now)
  if (!lock.allowed) {
    throw new RateLimitError(lock.retryAfterMs)
  }
  const counted = await deps.organizationDomains.recordAttempt(
    scope.environmentId,
    organizationId,
    claim.id,
    now,
    MAX_ATTEMPTS
  )
  if (!counted?.codeHash) {
    // Out of guesses for this code, or a request replaced or spent it meanwhile.
    throw new AuthError('verification.too_many_attempts')
  }
  const presented = await hashCode(deps, claim.id, claim.domain, code)
  if (!timingSafeEqual(presented, counted.codeHash)) {
    throw new AuthError('verification.invalid_code', {
      attemptsRemaining: MAX_ATTEMPTS - counted.codeAttempts,
    })
  }
  // A claim stored before the public list grew can no longer be verified.
  if (isPublicEmailDomain(claim.domain)) {
    throw new AuthError('organization.domain_public')
  }
  const result = await deps.organizationDomains.verify(
    scope.environmentId,
    organizationId,
    claim.id,
    counted.codeHash,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'organization_domain.verified',
      actor,
      target: { type: 'organization_domain', id: claim.id },
      data: {
        organizationId,
        domain: claim.domain,
        mode: counted.mode,
        ...(counted.mode === 'auto_join' && { weakened: true as const }),
      },
    })
  )
  if (result.outcome === 'taken') {
    throw new AuthError('organization.domain_taken')
  }
  if (result.outcome === 'stale') {
    throw new AuthError('verification.expired')
  }
  await deps.lockout.clear(lockKey)
  return view(result.record)
}

/**
 * Change what a domain does. Moving a domain to `auto_join` is a weakening: the event says
 * `weakened: true`.
 *
 * @param deps - Stores, settings, ids and clock.
 * @param scope - The project and environment.
 * @param organizationId - The organization.
 * @param domainId - The domain, pending or verified.
 * @param mode - The new mode.
 * @param actor - Who changes it, for the audit log.
 * @returns The domain.
 * @throws AuthError `organization.disabled`.
 * @throws NotFoundError when the organization or the domain does not exist.
 */
export async function setMode(
  deps: Pick<
    Deps,
    'organizations' | 'organizationDomains' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  scope: Scope,
  organizationId: string,
  domainId: string,
  mode: OrganizationDomainMode,
  actor: Actor
): Promise<OrganizationDomain> {
  await requireEnabled(deps, scope)
  await requireOrganization(deps, scope, organizationId)
  const current = await requireDomain(deps, scope, organizationId, domainId)
  const result = await deps.organizationDomains.setMode(
    scope.environmentId,
    organizationId,
    domainId,
    mode,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'organization_domain.updated',
      actor,
      target: { type: 'organization_domain', id: domainId },
      data: {
        organizationId,
        domain: current.domain,
        mode,
        // What the row held when the caller read it; the store answers the exact previous
        // mode, which differs only for a change racing this one.
        previousMode: current.mode,
        ...(mode === 'auto_join' && current.mode !== 'auto_join' && { weakened: true as const }),
      },
    })
  )
  if (result.outcome === 'not_found') {
    throw new NotFoundError()
  }
  return view(result.record)
}

/**
 * Remove a domain, pending or verified. Future sign-ups no longer join or are suggested the
 * organization because of it; members who joined stay members.
 *
 * @param deps - Stores, settings, ids and clock.
 * @param scope - The project and environment.
 * @param organizationId - The organization.
 * @param domainId - The domain.
 * @param actor - Who removes it, for the audit log.
 * @throws AuthError `organization.disabled`.
 * @throws NotFoundError when the organization or the domain does not exist.
 */
export async function remove(
  deps: Pick<
    Deps,
    'organizations' | 'organizationDomains' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  scope: Scope,
  organizationId: string,
  domainId: string,
  actor: Actor
): Promise<void> {
  await requireEnabled(deps, scope)
  await requireOrganization(deps, scope, organizationId)
  const current = await requireDomain(deps, scope, organizationId, domainId)
  const removed = await deps.organizationDomains.remove(
    scope.environmentId,
    organizationId,
    domainId,
    Audit.entry(deps, scope, {
      type: 'organization_domain.removed',
      actor,
      target: { type: 'organization_domain', id: domainId },
      data: { organizationId, domain: current.domain },
    })
  )
  if (!removed) {
    throw new NotFoundError()
  }
}

type MatchDeps = Pick<Deps, 'users' | 'organizationDomains'>

/**
 * The verified domain row that matches a user's **verified** address, or `null`.
 *
 * The one place the rule is written, for the sign-up join, the suggestions and the join of a
 * suggestion (which re-checks it on the server). It matches only when: the user exists and is
 * not banned; their address is **verified** (an unverified address never counts); the part
 * after the `@` is, exactly, a verified domain of the environment (no subdomain, no parent); and
 * the domain is not public (a claim stored before the list grew matches nothing).
 */
async function matchOf(
  deps: MatchDeps,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<OrganizationDomainRecord | null> {
  const user = await deps.users.findById(scope.environmentId, userId)
  if (!user || user.bannedAt !== null || user.emailVerifiedAt === null) {
    return null
  }
  const domain = user.emailNormalized ? domainOfAddress(user.emailNormalized) : null
  if (!domain || isPublicEmailDomain(domain)) {
    return null
  }
  return deps.organizationDomains.findVerified(scope.environmentId, domain)
}

/**
 * Join a user who has just signed up to the organization whose `auto_join` domain their
 * verified address is on, with the environment's default role. Called from the flow engine's
 * `finish`, so the membership is made, recorded (`organization_membership.added`, `via:
 * 'domain_auto_join'`) and evented in the same step as the sign-up's session.
 *
 * **Sign-up only**: a sign-in does not join. Someone an administrator removed would otherwise be
 * back at the next sign-in, and an account whose organization claimed the domain later is
 * offered the organization as a suggestion (they choose). A user already a member is left as
 * they are.
 *
 * **Never throws.** A sign-up that has succeeded is never failed, or delayed, by an
 * organization: any problem (organizations switched off, an unknown default role, a store
 * error) is logged by name and the user simply is not joined.
 *
 * @param deps - Stores, settings, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user who signed up.
 * @param actor - The system, with the request's origin.
 * @returns `true` when the user was joined.
 */
export async function joinOnSignUp(
  deps: Pick<
    Deps,
    | 'users'
    | 'organizations'
    | 'organizationDomains'
    | 'environmentSettings'
    | 'config'
    | 'ids'
    | 'clock'
  >,
  scope: Scope,
  userId: string,
  actor: Actor
): Promise<boolean> {
  try {
    const { organizations } = await Settings.current(deps, scope)
    if (!organizations.enabled) {
      return false
    }
    const match = await matchOf(deps, scope, userId)
    if (match?.mode !== 'auto_join') {
      return false
    }
    return (await addMember(deps, scope, match, userId, actor, 'domain_auto_join')) === 'added'
  } catch (error) {
    logger.warn('could not join a new user to the organization of their domain', {
      environmentId: scope.environmentId,
      userId,
      err: errorReason(error),
    })
    return false
  }
}

/**
 * Add the user to the organization of a matched domain with the environment's default role.
 *
 * @returns `added`, or `duplicate` when they are a member already, or `gone` when the
 *   organization, the user or the role vanished between the read and the write.
 */
async function addMember(
  deps: Pick<Deps, 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'>,
  scope: Scope,
  match: OrganizationDomainRecord,
  userId: string,
  actor: Actor,
  via: 'domain_auto_join' | 'domain_suggestion'
): Promise<'added' | 'duplicate' | 'gone'> {
  const { organizations } = await Settings.current(deps, scope)
  const role = await requireRole(deps, scope, organizations.defaultRole)
  const id = deps.ids.next()
  const at = deps.clock.now()
  const result = await deps.organizations.addMembership(
    {
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      organizationId: match.organizationId,
      userId,
      roleId: role.id,
      roleKey: role.key,
      createdAt: at,
      updatedAt: at,
    },
    Audit.entry(deps, scope, {
      type: 'organization_membership.added',
      actor,
      target: { type: 'organization_membership', id },
      data: { organizationId: match.organizationId, userId, role: role.key, via },
    })
  )
  return result.outcome === 'added' ? 'added' : result.outcome
}

/**
 * The organizations a signed-in user is suggested: the one whose verified domain their
 * **verified** address is on, if they are not a member of it. A `suggest` domain offers it,
 * and so does an `auto_join` one to a user who was not joined at sign-up (an account that
 * existed before the domain was claimed, or one removed since).
 *
 * @param deps - Stores and settings.
 * @param scope - The environment.
 * @param self - The signed-in user.
 * @returns The suggestions: at most one while a user has one address.
 * @throws AuthError `organization.disabled` while organizations are switched off.
 */
export async function suggestions(
  deps: Pick<
    Deps,
    'users' | 'organizations' | 'organizationDomains' | 'environmentSettings' | 'config'
  >,
  scope: Pick<Tenant, 'environmentId'>,
  self: Self
): Promise<OrganizationSuggestionList> {
  await requireEnabled(deps, scope)
  const match = await matchOf(deps, scope, self.userId)
  if (!match) {
    return { data: [] }
  }
  const [organization, membership] = await Promise.all([
    deps.organizations.find(scope.environmentId, match.organizationId),
    deps.organizations.findMembership(scope.environmentId, match.organizationId, self.userId),
  ])
  if (!organization || membership) {
    return { data: [] }
  }
  const suggestion: OrganizationSuggestion = {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
  }
  return { data: [suggestion] }
}

/**
 * Join a suggested organization, with the environment's default role.
 *
 * **Decided again on the server**: the organization must still have a verified domain that
 * the user's verified address is on, exactly, and a public domain never counts. Everything
 * else, an organization that does not exist, another environment's, one with no such domain
 * and a domain removed since the list was read, answers `organization.suggestion_unavailable`
 * alike: it says nothing about what exists.
 *
 * @param deps - Stores, settings, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user.
 * @param organizationId - The suggested organization.
 * @param actor - The user, for the audit log.
 * @returns The organization with the user's new role, as their own list shows it.
 * @throws AuthError `organization.disabled`, `organization.suggestion_unavailable`,
 *   `organization.member_exists`, `organization.role_unknown`.
 */
export async function joinSuggestion(
  deps: Pick<
    Deps,
    | 'users'
    | 'organizations'
    | 'organizationDomains'
    | 'environmentSettings'
    | 'config'
    | 'ids'
    | 'clock'
  >,
  scope: Scope,
  self: Self,
  organizationId: string,
  actor: Actor
): Promise<UserOrganization> {
  await requireEnabled(deps, scope)
  const match = await matchOf(deps, scope, self.userId)
  if (!match || match.organizationId !== organizationId) {
    throw new AuthError('organization.suggestion_unavailable')
  }
  const outcome = await addMember(deps, scope, match, self.userId, actor, 'domain_suggestion')
  if (outcome === 'duplicate') {
    throw new AuthError('organization.member_exists')
  }
  if (outcome === 'gone') {
    throw new AuthError('organization.suggestion_unavailable')
  }
  const held = await deps.organizations.findUserMembership(
    scope.environmentId,
    organizationId,
    self.userId
  )
  if (!held) {
    throw new AuthError('organization.suggestion_unavailable')
  }
  return {
    id: held.organization.id,
    name: held.organization.name,
    slug: held.organization.slug,
    role: held.membership.roleKey,
    permissions: [...held.permissions],
    createdAt: held.organization.createdAt.toISOString(),
  }
}
