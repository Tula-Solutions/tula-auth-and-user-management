import { Hono } from 'hono'
import type { AppEnv } from '~/dependencies'
import { ForbiddenError, NotFoundError } from '~/exceptions'

/**
 * The development SMS inbox (ADR 0037). **A development and test aid.**
 *
 * `createApp` mounts this router only when the deployment runs with `ENVIRONMENT=local` and
 * has an inbox (`SMS_PROVIDER=dev`; `env.ts` refuses that in every other tier, and with a
 * `PUBLIC_URL` that is not loopback). Everywhere else these paths do not exist. The handler
 * checks both again, so the inbox cannot answer even if it were mounted by mistake.
 *
 * It is for tools, not for pages: a request that carries an `Origin`, or that a browser
 * marks as coming from another site, is refused, so a page a developer happens to have open
 * cannot read the codes of the API running beside it. It is deliberately outside the OpenAPI
 * document: it is not part of the contract.
 */
const router = new Hono<AppEnv>()

// Mounted at `/v1/dev/sms`.
router.get('/messages', (c) => {
  const { config, smsInbox } = c.get('deps')
  if (config.tier !== 'local' || smsInbox === null) {
    throw new NotFoundError()
  }
  const site = c.req.header('sec-fetch-site')
  if (
    c.req.header('origin') !== undefined ||
    (site !== undefined && site !== 'none' && site !== 'same-origin')
  ) {
    throw new ForbiddenError()
  }
  c.header('Cache-Control', 'no-store')
  return c.json({
    messages: smsInbox.messages(c.req.query('to')).map((message) => ({
      to: message.to,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
    })),
  })
})

export default router
