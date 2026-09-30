import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { clientRateLimit } from '~/middleware/rate-limit'
import * as Passwords from '~/modules/password/service'
import * as openapi from '~/openapi'
import { PasswordPolicySchema } from './schema'

/** How long clients may cache the policy; a policy change reaches SDKs within this window. */
export const POLICY_MAX_AGE_SECONDS = 300

const router = new Hono<AppEnv>()

router.get(
  '/password-policy',
  describeRoute({
    operationId: 'getPasswordPolicy',
    tags: ['Passwords'],
    summary: 'Password policy',
    description:
      'The rules a new password must meet in this environment. SDKs evaluate them locally with ' +
      '`evaluatePassword` from `@tula/contract` to render a live checklist; the server enforces ' +
      'the same rules plus the breached-password check when a password is set.',
    security: openapi.security.client,
    responses: {
      200: {
        description: 'The active policy.',
        content: { 'application/json': { schema: resolver(PasswordPolicySchema) } },
      },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  clientRateLimit(),
  publishableKey(),
  async (c) => {
    const policy = await Passwords.policy(c.get('deps'), c.get('tenant'))
    c.header('Cache-Control', `private, max-age=${POLICY_MAX_AGE_SECONDS}`)
    // The response depends on which environment the key belongs to.
    c.header('Vary', PUBLISHABLE_KEY_HEADER, { append: true })
    return c.json(PasswordPolicySchema.parse(policy))
  }
)

export default router
