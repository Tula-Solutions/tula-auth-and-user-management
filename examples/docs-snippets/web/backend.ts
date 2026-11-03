// #region backend-imports
import { hasOrganizationAccess, readOrganizationClaims } from '@tula-tech/contract/custom-claims'
import { environmentIssuer, jwksUrl } from '@tula-tech/contract/issuer'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// #endregion

// A backend that is not Next.js verifies the access token itself and reads the organization
// claims, shown in docs/organizations.md. Copied by region (`bun run docs:generate`) and
// compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's id, from your own configuration. */
declare const environmentId: string

// #region backend-verify
// The token's `iss` is the environment's URL under the API, and its keys are published at
// the issuer's /.well-known/jwks.json. `createRemoteJWKSet` caches them and refetches when
// a token names a key it has not seen (a signing key was rotated).
const issuer = environmentIssuer('https://auth.example.com', environmentId)
const keys = createRemoteJWKSet(new URL(jwksUrl(issuer)))

/** Verify an access token and return the organization it acts in, or `null`. */
export async function organizationOf(accessToken: string) {
  const { payload } = await jwtVerify(accessToken, keys, {
    algorithms: ['EdDSA'],
    issuer,
    audience: environmentId,
  })
  // `org_id`, `org_role` and `org_perms` come together or not at all: `null` is "no
  // organization is active", and it grants nothing.
  return readOrganizationClaims(payload)
}
// #endregion

// #region backend-has
/** A request handler that lets a member through only if their role holds a permission. */
export async function handleInvoices(request: Request): Promise<Response> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!token) {
    return new Response('Unauthorized', { status: 401 })
  }
  const organization = await organizationOf(token).catch(() => null)
  if (!hasOrganizationAccess(organization, { permission: 'org:invoices:read' })) {
    return new Response('Forbidden', { status: 403 })
  }
  return Response.json({ organizationId: organization?.orgId, invoices: [] })
}
// #endregion
