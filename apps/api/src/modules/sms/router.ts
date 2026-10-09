import { SMS_USAGE_DEFAULT_DAYS, SMS_USAGE_MAX_DAYS, SMS_USAGE_MAX_PREFIXES } from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Sms from '~/modules/sms/service'
import * as openapi from '~/openapi'
import { SmsUsageQuerySchema, SmsUsageSchema } from './schema'

// Mounted at `/v1/admin/sms`: what an operator reads of the text messages an environment
// sent (ADR 0037). Counts only; no route here sends anything.
const router = new Hono<AppEnv>()

router.get(
  '/usage',
  describeRoute({
    operationId: 'getSmsUsage',
    tags: ['SMS'],
    summary: 'Codes texted and used, by destination prefix',
    description:
      'How many verification codes the environment texted in the last `days` days (UTC, ' +
      `today included; ${SMS_USAGE_DEFAULT_DAYS} unless given, at most ${SMS_USAGE_MAX_DAYS}), ` +
      'and how many of them were then entered correctly, by **destination prefix**: the ' +
      'country calling prefix of the numbers (`+49`, or `+1242` where countries share a ' +
      'calling code), never more of a number. A prefix where nearly every code goes unused ' +
      'is what SMS pumping looks like. `prefixes` lists those with the most unused codes first, at most ' +
      `${SMS_USAGE_MAX_PREFIXES} (\`truncated\` says when there are more); \`sent\`, \`used\` ` +
      'and `unused` are the totals over every prefix. A send that a limit refused, or that ' +
      'the sender did not take, is not a code sent. The answer holds counts only: no phone ' +
      'number, and nothing about who asked.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The counts.',
        content: { 'application/json': { schema: resolver(SmsUsageSchema) } },
      },
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', SmsUsageQuerySchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      SmsUsageSchema.parse(await Sms.usage(c.get('deps'), c.get('tenant'), c.req.valid('query')))
    )
  }
)

export default router
