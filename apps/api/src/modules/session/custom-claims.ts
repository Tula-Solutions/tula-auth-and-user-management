import {
  type CustomClaimValue,
  customClaimsBytes,
  isCustomClaimKey,
  isCustomClaimValue,
  type JwtTemplateClaim,
  MAX_CUSTOM_CLAIMS_BYTES,
  type NamedJwtTemplate,
} from '@tula/contract'
import * as logger from '~/lib/logger'
import type { SessionRecord } from '~/ports/session-store'
import type { UserRecord } from '~/ports/user-repository'

// The custom claims of a session (ADR 0036): what its profile's JWT template says, read from
// the user and the session as they are when a token is issued. Everything here is a pure
// function of server-side records; nothing a request carries can reach a claim.

/** What a template's sources are read from. */
export interface ClaimFacts {
  /** The session's user in the session's own environment; `null` when there is none. */
  user: Pick<UserRecord, 'emailNormalized' | 'emailVerifiedAt' | 'createdAt'> | null
  /** The session. */
  session: Pick<SessionRecord, 'client' | 'createdAt'>
  /** The environment, for the warning when claims are dropped. */
  environmentId?: string
}

/** Custom claims by key. */
export type Claims = Record<string, CustomClaimValue>

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

/** The value of one claim, or `undefined` when its source has none for this user and session. */
function claimValue(claim: JwtTemplateClaim, facts: ClaimFacts): CustomClaimValue | undefined {
  if ('value' in claim) {
    return claim.value
  }
  const { user, session } = facts
  // A switch over a closed list. A source this version does not know (a stored document a
  // newer server wrote) has no value: nothing is guessed from its name.
  switch (claim.from) {
    case 'user.email':
      return user?.emailNormalized
    case 'user.email_verified':
      return user ? user.emailVerifiedAt !== null : undefined
    case 'user.created_at':
      return user ? seconds(user.createdAt) : undefined
    case 'session.client':
      return session.client
    case 'session.created_at':
      return seconds(session.createdAt)
    default:
      return undefined
  }
}

/**
 * Whether a template reads anything from the user. Only then is the user loaded for a token:
 * a template of constants and session facts costs no read.
 *
 * @param template - The profile's template, if it has one.
 * @returns `true` when one of its claims has a `user.*` source.
 */
export function needsUser(template: NamedJwtTemplate | null): boolean {
  return Object.values(template?.template.claims ?? {}).some(
    (claim) => 'from' in claim && claim.from.startsWith('user.')
  )
}

/**
 * The custom claims of a session, to be issued under the namespace claim.
 *
 * - A source with no value for this user leaves its key out; nothing is ever `null`.
 * - No claims at all is `undefined`, so the caller issues **no** namespace claim, not an
 *   empty one: a session without custom claims is exactly what it was before they existed.
 * - `extra` is for a later source of claims (a hook, a later ticket): its entries are merged
 *   over the template's under the same namespace, keys and values are held to the same
 *   rules as a template's (`isCustomClaimKey`, one scalar), and the whole is under the same
 *   cap.
 * - A result larger than `MAX_CUSTOM_CLAIMS_BYTES` is dropped **whole** and logged by the
 *   template's name. A saved template cannot produce one (`jwtTemplateMaxBytes` is an upper
 *   bound, checked when settings are saved); this is the defence behind that. A sign-in is
 *   not failed and no value is cut short: an application that authorizes on a claim reads a
 *   missing one as "no".
 *
 * @param template - The profile's template as configured now, or `null`.
 * @param facts - The user and the session the sources are read from.
 * @param extra - Claims from other sources, later ones winning.
 * @returns The claims, or `undefined` when there are none.
 */
export function build(
  template: NamedJwtTemplate | null,
  facts: ClaimFacts,
  extra: readonly Readonly<Record<string, unknown>>[] = []
): Claims | undefined {
  const entries: [string, CustomClaimValue][] = []
  for (const [key, claim] of Object.entries(template?.template.claims ?? {})) {
    const value = claimValue(claim, facts)
    if (isCustomClaimKey(key) && isCustomClaimValue(value)) {
      entries.push([key, value])
    }
  }
  for (const source of extra) {
    for (const key of Object.keys(source)) {
      const value = source[key]
      if (isCustomClaimKey(key) && isCustomClaimValue(value)) {
        entries.push([key, value])
      }
    }
  }
  if (entries.length === 0) {
    return undefined
  }
  // `fromEntries` defines own properties: no key can reach a prototype.
  const claims: Claims = Object.fromEntries(entries)
  const bytes = customClaimsBytes(claims)
  if (bytes > MAX_CUSTOM_CLAIMS_BYTES) {
    // Names and sizes only: a claim's value may be an address.
    logger.warn('custom claims over the size cap; the session is issued without them', {
      environmentId: facts.environmentId,
      template: template?.name ?? null,
      bytes,
      max: MAX_CUSTOM_CLAIMS_BYTES,
    })
    return undefined
  }
  return claims
}
