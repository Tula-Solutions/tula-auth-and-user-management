import { JwksSchema } from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Jwks from '~/modules/jwks/service'
import * as openapi from '~/openapi'
import { EnvironmentIdParamSchema, SigningKeyListSchema } from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

router.get(
  '/environments/:environmentId/.well-known/jwks.json',
  describeRoute({
    operationId: 'getJwks',
    tags: ['Keys'],
    summary: 'Public signing keys',
    description:
      'The Ed25519 keys that verify this environment’s access tokens. The URL is the token’s ' +
      '`iss` plus `/.well-known/jwks.json`, so standard JWKS clients can find it.',
    security: openapi.security.public,
    responses: {
      200: { description: 'The key set.', content: json(JwksSchema) },
      404: openapi.responses[404],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  // Public and uncredentialed, and each call checks the environment in the database.
  rateLimit({
    name: 'jwks',
    limit: 600,
    window: '1m',
    key: byIp,
    // Public keys are not a secret, and services verifying tokens fetch them from here: an
    // outage of the limiter's store must not stop them (ADR 0016).
    whenUnavailable: 'allow',
  }),
  validator('param', EnvironmentIdParamSchema, validationHook),
  async (c) => {
    const set = await Jwks.publicKeySet(c.get('deps'), c.req.valid('param').environmentId)
    // An empty set can only be transient (bootstrap failed); never let a verifier keep it.
    c.header(
      'Cache-Control',
      set.keys.length > 0 ? `public, max-age=${Jwks.JWKS_MAX_AGE_SECONDS}` : 'no-store'
    )
    return c.json(JwksSchema.parse(set))
  }
)

router.get(
  '/admin/signing-keys',
  describeRoute({
    operationId: 'listSigningKeys',
    tags: ['Keys'],
    summary: 'List signing keys',
    description: 'Lifecycle of the secret key’s environment’s signing keys. No key material.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The keys, newest first.', content: json(SigningKeyListSchema) },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Jwks.listKeys(c.get('deps'), c.get('tenant'))
    return c.json(SigningKeyListSchema.parse({ data }))
  }
)

router.post(
  '/admin/signing-keys/rotate',
  describeRoute({
    operationId: 'rotateSigningKeys',
    tags: ['Keys'],
    summary: 'Rotate signing keys',
    description:
      'Activates the pre-published `next` key, retires the active key (still published for ' +
      'verification briefly) and publishes a new `next` key. Refused with 409 while the `next` ' +
      'key is too new for caches to have seen it.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The keys after rotation.', content: json(SigningKeyListSchema) },
      401: openapi.responses[401],
      409: openapi.responses[409],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Jwks.rotate(c.get('deps'), c.get('tenant'), adminActor(c))
    return c.json(SigningKeyListSchema.parse({ data }))
  }
)

export default router
