import type { Deps } from '~/dependencies'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import { errorReason } from '~/lib/safe-error'
import { plural } from './helpers'
import type { DiagnosticCheck } from './schema'

/** A certificate that ends within this many days is reported before it does (ADR 0067). */
export const CERTIFICATE_WARNING_DAYS = 30

/**
 * Metadata addresses requested in one run, over all environments: each is a request to an
 * operator's address, so the scan is bounded. A run that stopped there says so.
 */
export const METADATA_FETCHES_PER_RUN = 10

/** One request to a metadata address: it must answer, not be read. */
const METADATA_TIMEOUT_MS = 5_000
const METADATA_MAX_BYTES = 512 * 1024

type SsoDeps = Pick<Deps, 'ssoConnections' | 'organizationDomains' | 'outbound' | 'clock'>

/** What the scan found about active SSO connections, as counts: never a name, domain or address. */
export interface SsoFindings {
  /** Active connections looked at. */
  connections: number
  /** Active SAML connections whose newest certificate has ended. */
  expired: number
  /** Those whose newest certificate ends within {@link CERTIFICATE_WARNING_DAYS} days. */
  expiring: number
  /** Connections with a bound domain that no longer has a verified claim by their organization. */
  unverified: number
  /** Metadata addresses requested, and those that did not answer with a success. */
  fetched: number
  unreachable: number
  /** Addresses left unrequested because {@link METADATA_FETCHES_PER_RUN} was reached. */
  notFetched: number
}

/**
 * The findings of a scan that has looked at nothing yet.
 *
 * @returns Every count at zero.
 */
export function noFindings(): SsoFindings {
  return {
    connections: 0,
    expired: 0,
    expiring: 0,
    unverified: 0,
    fetched: 0,
    unreachable: 0,
    notFetched: 0,
  }
}

/** Whether a metadata address answered 2xx. Every failure is one word: no reason reaches an answer. */
async function answers(deps: Pick<Deps, 'outbound'>, address: string): Promise<boolean> {
  try {
    const response = await Outbound.request(deps.outbound, address, {
      timeoutMs: METADATA_TIMEOUT_MS,
      maxResponseBytes: METADATA_MAX_BYTES,
    })
    return response.status >= 200 && response.status < 300
  } catch (error) {
    logger.warn('diagnostic check failed', { check: 'sso_connections', reason: errorReason(error) })
    return false
  }
}

/**
 * Add one environment's active connections to the findings.
 *
 * @param deps - Stores, the outbound guard and the clock.
 * @param environmentId - The environment.
 * @param found - The findings so far.
 * @param signal - The scan's deadline, looked at before every request.
 * @returns The findings with this environment added.
 */
export async function read(
  deps: SsoDeps,
  environmentId: string,
  found: SsoFindings,
  signal: AbortSignal
): Promise<SsoFindings> {
  const now = deps.clock.now().getTime()
  const horizon = now + CERTIFICATE_WARNING_DAYS * 86_400_000
  const next = { ...found }
  for (const connection of await deps.ssoConnections.list(environmentId)) {
    if (connection.status !== 'active') {
      continue
    }
    signal.throwIfAborted()
    next.connections += 1
    if (connection.saml) {
      const newest = Math.max(...connection.saml.certificates.map((c) => Date.parse(c.notAfter)))
      next.expired += newest <= now ? 1 : 0
      next.expiring += newest > now && newest <= horizon ? 1 : 0
      const address = connection.saml.metadataUrl
      if (address !== null) {
        if (next.fetched >= METADATA_FETCHES_PER_RUN) {
          next.notFetched += 1
        } else {
          next.fetched += 1
          next.unreachable += (await answers(deps, address)) ? 0 : 1
        }
      }
    }
    for (const domain of connection.domains) {
      const claim = await deps.organizationDomains.findVerified(environmentId, domain)
      if (claim?.organizationId !== connection.organizationId) {
        next.unverified += 1
        break
      }
    }
  }
  return next
}

/**
 * The `sso_connections` check. Counts and fixed words only: never a connection's name, a
 * domain, an address, a certificate or an environment's id. The metadata addresses are
 * requested through the outbound guard, like every address an operator typed.
 *
 * @param stored - The scan's result, or `null` when it could not run.
 * @returns The check.
 */
export function check(stored: { value: { sso: SsoFindings | null } } | null): DiagnosticCheck {
  const id = 'sso_connections'
  const found = stored?.value.sso ?? null
  if (!found) {
    return {
      id,
      status: 'skipped',
      summary: 'Not checked: the SSO connections could not be read from the database.',
    }
  }
  if (found.connections === 0) {
    return {
      id,
      status: 'skipped',
      summary: 'No active SSO connection in the environments looked at.',
    }
  }
  const problems: string[] = []
  if (found.expired > 0) {
    problems.push(
      `${plural(found.expired, 'connection')} signing certificate has ended: sign-in through it is refused`
    )
  }
  if (found.expiring > 0) {
    problems.push(
      `${plural(found.expiring, 'connection')} signing certificate ends within ${CERTIFICATE_WARNING_DAYS} days`
    )
  }
  if (found.unreachable > 0) {
    problems.push(`${plural(found.unreachable, 'metadata address')} did not answer`)
  }
  if (found.unverified > 0) {
    problems.push(
      `${plural(found.unverified, 'connection')} bound domain is no longer verified by its organization`
    )
  }
  const partial =
    found.notFetched > 0
      ? ` ${plural(found.notFetched, 'metadata address')} was not requested: a run requests at most ${METADATA_FETCHES_PER_RUN}.`
      : ''
  if (problems.length === 0) {
    return {
      id,
      status: partial ? 'warn' : 'ok',
      summary: `${plural(found.connections, 'active SSO connection')} looked at: certificates are valid for more than ${CERTIFICATE_WARNING_DAYS} days, metadata addresses answer and bound domains are verified.${partial}`,
    }
  }
  return {
    id,
    status: found.expired > 0 ? 'fail' : 'warn',
    summary: `${problems.join('; ')}.${partial}`,
    fix: 'Rotate the identity provider’s certificate in the connection (refresh its metadata or paste the new certificate), check the metadata address, and verify the domain again in the organization. `get_sso_connection` and the dashboard show which connection.',
  }
}
