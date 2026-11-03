import { z } from 'zod'
import type { ScimToken } from '~/api/generated/api.gen'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import type { FakeOrganization } from './fake-organizations'
import { invalid } from './fake-webhooks'

// The fake API's SCIM token routes (`/v1/admin/scim-tokens`): the shapes and refusals of
// `apps/api/src/modules/scim-token`, on plain in-memory data.
//
// What it keeps of the API: every route answers `organization.disabled` (403) while the
// environment has organizations off (not `sso.disabled`: SCIM tokens do not depend on the
// SSO switch); an organization of another environment is a 404; the list is newest first and
// holds revoked tokens; the secret is in the create answer and nowhere else; at most ten live
// tokens (`resource.conflict`, 409); a revoked or unknown token is a 404.
// Where it differs, on purpose: the secret is made up, and there is no rate limit or audit log.

const ENVIRONMENT = 'x-tula-environment'
/** Most live tokens an organization holds, as in `modules/scim-token/service.ts`. */
export const FAKE_MAX_LIVE_SCIM_TOKENS = 10

/** A token as the fake holds it: the API's view, the environment and the secret it sent once. */
export interface FakeScimToken extends ScimToken {
  environmentId: string
  secret: string
}

/** The part of the fake's state the SCIM routes work on. */
export interface FakeScimState {
  scimTokens: FakeScimToken[]
}

/** What the routes ask of the rest of the fake. */
export interface FakeScimContext {
  /** Whether the environment has organizations switched on. */
  enabled: () => boolean
  organizations: () => FakeOrganization[]
}

let made = 0

/**
 * A token for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs; `organizationId` should be given.
 * @returns The token.
 */
export function fakeScimToken(overrides: Partial<FakeScimToken> = {}): FakeScimToken {
  made += 1
  const n = String(made).padStart(11, '0')
  return {
    id: `00000000-0000-7000-8000-f${n}`,
    environmentId: IDS.development,
    organizationId: '00000000-0000-7000-8000-0000000aaa01',
    name: 'Okta provisioning',
    prefix: `tula_scim_dev_${n.slice(-4)}`,
    secret: `tula_scim_dev_secret-${n}`,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: '2026-10-23T12:00:00.000Z',
    ...overrides,
  }
}

function view({ environmentId: _e, secret: _s, ...token }: FakeScimToken): ScimToken {
  return token
}

const Query = z.object({ organizationId: z.uuid() })
const Create = z
  .object({ organizationId: z.uuid(), name: z.string().trim().min(1).max(100) })
  .strict()

/**
 * The SCIM token routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its SCIM part.
 * @param context - What the routes ask of the rest of the fake.
 * @returns The routes, in the fake's own table format.
 */
export function scimRoutes(
  state: FakeScimState,
  context: FakeScimContext
): [string, RegExp, FakeHandler][] {
  const environmentOf = (call: FakeCall) => call.headers.get(ENVIRONMENT) ?? ''
  const off = () =>
    failure(403, 'organization.disabled', 'Organizations are not enabled for this environment.')
  const missing = () => failure(404, 'resource.not_found', 'The resource does not exist.')
  const hasOrganization = (call: FakeCall, id: string) =>
    context.organizations().some((o) => o.id === id && o.environmentId === environmentOf(call))

  return [
    [
      'GET',
      /^\/v1\/admin\/scim-tokens$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const query = Query.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        if (!hasOrganization(call, query.data.organizationId)) {
          return missing()
        }
        return {
          tokens: state.scimTokens
            .filter(
              (t) =>
                t.environmentId === environmentOf(call) &&
                t.organizationId === query.data.organizationId
            )
            .map(view)
            .reverse(),
        }
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/scim-tokens$/,
      (call) => {
        if (!context.enabled()) {
          return off()
        }
        const body = Create.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        if (!hasOrganization(call, body.data.organizationId)) {
          return missing()
        }
        const live = state.scimTokens.filter(
          (t) =>
            t.environmentId === environmentOf(call) &&
            t.organizationId === body.data.organizationId &&
            t.revokedAt === null
        )
        if (live.length >= FAKE_MAX_LIVE_SCIM_TOKENS) {
          return failure(
            409,
            'resource.conflict',
            'The organization holds the most SCIM tokens allowed.'
          )
        }
        const token = fakeScimToken({
          environmentId: environmentOf(call),
          organizationId: body.data.organizationId,
          name: body.data.name,
          createdAt: new Date().toISOString(),
        })
        state.scimTokens.push(token)
        return new Response(
          JSON.stringify({
            ...view(token),
            token: token.secret,
            scimBaseUrl: 'https://auth.example.test/v1/scim/v2',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }
        )
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/scim-tokens\/([^/]+)$/,
      (call, match) => {
        if (!context.enabled()) {
          return off()
        }
        const query = Query.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        if (!hasOrganization(call, query.data.organizationId)) {
          return missing()
        }
        const found = state.scimTokens.find(
          (t) =>
            t.id === match[1] &&
            t.environmentId === environmentOf(call) &&
            t.organizationId === query.data.organizationId &&
            t.revokedAt === null
        )
        if (!found) {
          return missing()
        }
        found.revokedAt = new Date().toISOString()
        return new Response(null, { status: 204 })
      },
    ],
  ]
}
