import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { onError } from '~/handlers'
import { directoryActor } from '~/lib/actor'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { SCIM_IP_RATE_LIMIT, type ScimVariables, scimToken } from '~/middleware/scim-token'
import * as Organizations from '~/modules/organization/service'
import { invalidValue, ScimError } from './errors'
import * as Groups from './groups'
import {
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  ScimGroupInputSchema,
  ScimListQuerySchema,
  ScimPatchSchema,
  ScimUserInputSchema,
  USER_SCHEMA,
} from './schema'
import * as Scim from './service'

type ScimEnv = AppEnv & { Variables: TenantVariables & ScimVariables }

// Deliberately no `describeRoute()`: these routes are not in openapi.json, so no SDK or the
// dashboard is generated from them. They are documented in docs/scim.md (ADR 0067).
const router = new Hono<ScimEnv>()

const SCIM_JSON = 'application/scim+json'

/** The same error body, as RFC 7644 section 3.12 has it, on these routes only. */
router.onError(async (err, c) => {
  const response = onError(err, c as never)
  const { detail } = (await response.clone().json()) as { detail?: string }
  const headers = new Headers(response.headers)
  headers.set('content-type', SCIM_JSON)
  headers.delete('content-length')
  return new Response(
    JSON.stringify({
      schemas: [ERROR_SCHEMA],
      status: String(response.status),
      ...(err instanceof ScimError && { scimType: err.scimType }),
      detail,
    }),
    { status: response.status, headers }
  )
})

// The address is limited first so that guessed tokens count too; the token's own and the
// organization's limits are in `scimToken()`.
router.use(
  '*',
  rateLimit({ name: 'scim', limit: SCIM_IP_RATE_LIMIT, window: '1m', key: byIp }) as never
)
router.use('*', scimToken())
router.use('*', async (c, next) => {
  await Organizations.requireEnabled(c.get('deps'), c.get('tenant'))
  await next()
})

function answer(c: Context<ScimEnv>, body: unknown, status: ContentfulStatusCode = 200) {
  return c.body(JSON.stringify(body), status, { 'content-type': SCIM_JSON })
}

function context(c: Context<ScimEnv>): Scim.ScimContext {
  const tenant = c.get('tenant')
  return {
    tenant: { projectId: tenant.projectId, environmentId: tenant.environmentId },
    organizationId: c.get('scim').organizationId,
    actor: directoryActor(c),
  }
}

async function bodyOf<S extends z.ZodType>(c: Context<ScimEnv>, schema: S): Promise<z.output<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ScimError('request.malformed', 'invalidSyntax', 'The body is not JSON.')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw invalidValue('The body is not a valid SCIM resource.')
  }
  return parsed.data
}

router.get('/Users', async (c) => {
  const query = ScimListQuerySchema.safeParse(c.req.query())
  if (!query.success) {
    throw invalidValue('startIndex and count are whole numbers.')
  }
  return answer(c, await Scim.list(c.get('deps'), context(c), query.data))
})

router.post('/Users', async (c) =>
  answer(c, await Scim.create(c.get('deps'), context(c), await bodyOf(c, ScimUserInputSchema)), 201)
)

router.get('/Users/:id', async (c) =>
  answer(c, await Scim.get(c.get('deps'), context(c), c.req.param('id')))
)

router.put('/Users/:id', async (c) =>
  answer(
    c,
    await Scim.replace(
      c.get('deps'),
      context(c),
      c.req.param('id'),
      await bodyOf(c, ScimUserInputSchema)
    )
  )
)

router.patch('/Users/:id', async (c) =>
  answer(
    c,
    await Scim.patch(
      c.get('deps'),
      context(c),
      c.req.param('id'),
      (await bodyOf(c, ScimPatchSchema)).Operations
    )
  )
)

router.delete('/Users/:id', async (c) => {
  await Scim.remove(c.get('deps'), context(c), c.req.param('id'))
  return c.body(null, 204)
})

router.get('/Groups', async (c) => {
  const query = ScimListQuerySchema.safeParse(c.req.query())
  if (!query.success) {
    throw invalidValue('startIndex and count are whole numbers.')
  }
  return answer(c, await Groups.list(c.get('deps'), context(c), query.data))
})

router.post('/Groups', async (c) =>
  answer(
    c,
    await Groups.create(c.get('deps'), context(c), await bodyOf(c, ScimGroupInputSchema)),
    201
  )
)

router.get('/Groups/:id', async (c) =>
  answer(c, await Groups.get(c.get('deps'), context(c), c.req.param('id')))
)

router.put('/Groups/:id', async (c) =>
  answer(
    c,
    await Groups.replace(
      c.get('deps'),
      context(c),
      c.req.param('id'),
      await bodyOf(c, ScimGroupInputSchema)
    )
  )
)

router.patch('/Groups/:id', async (c) =>
  answer(
    c,
    await Groups.patch(
      c.get('deps'),
      context(c),
      c.req.param('id'),
      (await bodyOf(c, ScimPatchSchema)).Operations
    )
  )
)

router.delete('/Groups/:id', async (c) => {
  await Groups.remove(c.get('deps'), context(c), c.req.param('id'))
  return c.body(null, 204)
})

const USER_TYPE = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
  id: 'User',
  name: 'User',
  endpoint: '/Users',
  schema: USER_SCHEMA,
}

const USER_DEFINITION = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
  id: USER_SCHEMA,
  name: 'User',
  description: 'A user provisioned by an organization’s directory.',
  attributes: [
    {
      name: 'userName',
      type: 'string',
      multiValued: false,
      required: true,
      mutability: 'readOnly',
    },
    {
      name: 'externalId',
      type: 'string',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
    },
    {
      name: 'active',
      type: 'boolean',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
    },
  ],
}

const GROUP_TYPE = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
  id: 'Group',
  name: 'Group',
  endpoint: '/Groups',
  schema: GROUP_SCHEMA,
}

const GROUP_DEFINITION = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
  id: GROUP_SCHEMA,
  name: 'Group',
  description: 'A group of an organization’s directory, mapped to organization roles.',
  attributes: [
    {
      name: 'displayName',
      type: 'string',
      multiValued: false,
      required: true,
      mutability: 'readWrite',
    },
    {
      name: 'externalId',
      type: 'string',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
    },
    {
      name: 'members',
      type: 'complex',
      multiValued: true,
      required: false,
      mutability: 'readWrite',
    },
  ],
}

const listOf = (resources: unknown[]) => ({
  schemas: [LIST_SCHEMA],
  totalResults: resources.length,
  startIndex: 1,
  itemsPerPage: resources.length,
  Resources: resources,
})

router.get('/ServiceProviderConfig', (c) =>
  answer(c, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: Scim.MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'SCIM token',
        description: 'A SCIM token of the organization, in the Authorization header.',
      },
    ],
  })
)

router.get('/ResourceTypes', (c) => answer(c, listOf([USER_TYPE, GROUP_TYPE])))
router.get('/Schemas', (c) => answer(c, listOf([USER_DEFINITION, GROUP_DEFINITION])))

// The group's middleware sets the tenant and `scim` variables, so inside it the handlers see
// them; the app mounts every router as `Hono<AppEnv>`, whose variables are those it starts with.
export default router as unknown as Hono<AppEnv>
