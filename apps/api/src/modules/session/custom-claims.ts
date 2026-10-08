import {
  type CustomClaimValue,
  checkCustomClaims,
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
// function of server-side records; nothing a request carries can reach a claim. Beside them go
// the claims a `before_token` hook gave the session (ADR 0035), which are stored on its row:
// `stored` reads them back, and `build` merges the two under the one cap.

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
 * - `extra` is for the claims of a `before_token` hook (ADR 0035), read from the session's
 *   row through {@link stored}: its entries are merged **over** the template's under the
 *   same namespace (a template is the profile's default for every user, a hook's claim is
 *   about this one), keys and values are held to the same rules as a template's
 *   (`isCustomClaimKey`, one scalar), and the whole is under the same cap.
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
  const claims = merged(template, facts, extra)
  if (Object.keys(claims).length === 0) {
    return undefined
  }
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

/** The template's claims with each later source's over them, before any cap. */
function merged(
  template: NamedJwtTemplate | null,
  facts: ClaimFacts,
  extra: readonly Readonly<Record<string, unknown>>[]
): Claims {
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
  // `fromEntries` defines own properties: no key can reach a prototype.
  return Object.fromEntries(entries)
}

/**
 * Whether a hook's claims can be issued beside the template's: the cap is on the two merged,
 * as a token would carry them. Asked when the hook answers, so that claims that do not fit
 * are a failed call (`claims_too_large`) and are never stored, cut or silently dropped.
 *
 * @param template - The profile's template as configured now, or `null`.
 * @param facts - The user and the session the template's sources are read from.
 * @param claims - The hook's claims.
 * @returns `true` when the merged claims are within `MAX_CUSTOM_CLAIMS_BYTES`.
 */
export function fits(
  template: NamedJwtTemplate | null,
  facts: ClaimFacts,
  claims: Readonly<Record<string, unknown>>
): boolean {
  return customClaimsBytes(merged(template, facts, [claims])) <= MAX_CUSTOM_CLAIMS_BYTES
}

/**
 * The claims a hook gave a session, as read from its row: **judged again**, by the same one
 * definition that judged the hook's answer (`checkCustomClaims`). A row is not trusted for
 * having been written by this server: it may come from another version or a restored backup.
 * A value that breaks a rule (a reserved or malformed key, a value that is not one scalar,
 * more than the cap, not an object) is dropped **whole** and named in a warning by the
 * session's id, never by its content; the session's token is then issued without a hook's
 * claims. It is never an error: this runs on every refresh.
 *
 * @param value - The row's `hookClaims`.
 * @param session - The environment and the session, for the warning.
 * @returns The claims, or `null` for none.
 */
export function stored(
  value: unknown,
  session: { environmentId: string; sessionId: string }
): Claims | null {
  if (value === null || value === undefined) {
    return null
  }
  const checked = checkCustomClaims(value)
  if ('problem' in checked) {
    logger.warn('a session’s stored hook claims break a rule; issued without them', {
      ...session,
      problem: checked.problem,
    })
    return null
  }
  return Object.keys(checked.claims).length > 0 ? checked.claims : null
}
