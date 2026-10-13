import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminRateLimit, byEnvironment, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as openapi from '~/openapi'
import { MessagePreviewRequestSchema, MessagePreviewSchema } from './schema'
import * as MessagePreview from './service'

/** Previews one environment may ask for in a minute. */
export const MESSAGE_PREVIEW_RATE_LIMIT = 120

/**
 * The limit of the preview route, per environment: an editor asks again as the operator
 * types (after a pause), so it is well above what one screen needs and well below the
 * general admin limit per address. A preview sends nothing and reads one settings document,
 * so a limiter that cannot count lets it through.
 */
const previewRateLimit = rateLimit({
  name: 'message_preview',
  limit: MESSAGE_PREVIEW_RATE_LIMIT,
  window: '1m',
  key: byEnvironment,
  whenUnavailable: 'allow',
})

// Mounted at `/v1/admin/message-preview` (ADR 0042).
const router = new Hono<AppEnv>()

router.post(
  '/',
  describeRoute({
    operationId: 'previewMessage',
    tags: ['Settings'],
    summary: 'Preview an email or a text message in a draft wording',
    description:
      'Draws one kind of email (`channel: "email"`) or text message (`channel: "sms"`) as the ' +
      'server would word it, from fixed sample values (the code is always `123456`), with the ' +
      'environment’s saved app name, support address and first allowed origin. `template` is ' +
      'a draft: it is held to exactly the rules a saved template is and refused the same way ' +
      '(422, under `template.<field>`), and it is not saved. Without one the answer is the ' +
      'built-in copy. The answer is **text**: an email’s subject and plain-text part, or the ' +
      'whole text message with the server’s own last line; never HTML. A part of the draft ' +
      'the server would not use for this message is listed in `unused` and drawn as the ' +
      'built-in copy. Nothing is sent, stored or recorded. Limited to ' +
      `${MESSAGE_PREVIEW_RATE_LIMIT} previews a minute per environment.`,
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The message.',
        content: { 'application/json': { schema: resolver(MessagePreviewSchema) } },
      },
      413: openapi.responses[413],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  previewRateLimit,
  validator('json', MessagePreviewRequestSchema, validationHook),
  async (c) => {
    // A draft is the operator's unsaved text: not something for a cache.
    c.header('Cache-Control', 'no-store')
    return c.json(
      MessagePreviewSchema.parse(
        await MessagePreview.preview(c.get('deps'), c.get('tenant'), c.req.valid('json'))
      )
    )
  }
)

export default router
