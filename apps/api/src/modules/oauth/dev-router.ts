import {
  givesNoAddress,
  IdTokenProviderSchema,
  MicrosoftTenantSchema,
  OAUTH_PROVIDERS,
  OAuthProviderSchema,
} from '@tula/contract'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { isGuid, MICROSOFT_CONSUMER_TENANT_ID, microsoftSubject } from '~/adapters/oauth/microsoft'
import { issueMockCode, issueMockIdToken } from '~/adapters/oauth/mock'
import type { AppEnv } from '~/dependencies'
import { isLoopbackHost } from '~/env'
import { ForbiddenError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import { parseEmail } from '~/lib/email'
import { escapeHtml } from '~/modules/email/templates'
import * as OAuth from '~/modules/oauth/service'

/**
 * The mock OAuth provider's consent page (ADR 0026). **A development and test aid.**
 *
 * `createApp` mounts this router only when the deployment runs with `ENVIRONMENT=local` and
 * `OAUTH_MOCK_PROVIDER=true` (`env.ts` refuses that variable in every other tier); everywhere
 * else these paths do not exist. Each handler checks the configuration again, so the page cannot
 * answer even if it were mounted by mistake.
 *
 * It plays the part of the provider: `GET` shows a form asking which address the "provider"
 * should assert, `POST` issues a code and sends the browser to this API's real callback, which
 * then runs exactly the code a real provider's answer runs. It is deliberately outside the
 * OpenAPI document: it is not part of the contract.
 *
 * For Microsoft the form asks what a Microsoft token says instead of one account id: the
 * tenant id, the object id, and whether the verified-domain claim (`xms_edov`) is there.
 * For LinkedIn what the form says becomes a userinfo answer (`sub`, `email`, `email_verified`,
 * the names) carried in the code, which is where the adapter reads a LinkedIn profile from.
 * For X and Facebook the address typed is carried in the code and **dropped by the mock
 * adapter**, as the real adapters read none: it is there to derive an account id from and to
 * show that an address the provider reports reaches nothing.
 *
 * `POST /id-token` is the same aid for a native sign-in (ADR 0045), where there is no page:
 * it mints the ID token the provider's SDK would have handed the app. It is for tools and
 * is guarded more tightly than the consent page (see the handler).
 */
const router = new Hono<AppEnv>()

const ParamsSchema = z.object({
  provider: OAuthProviderSchema,
  client_id: z.string().min(1).max(512),
  redirect_uri: z.string().max(2048),
  state: z.string().min(1).max(512),
  nonce: z.string().min(1).max(512),
  code_challenge: z.string().min(1).max(512),
  /** Microsoft only: the environment's `tenant`, so that the page offers a tenant id it accepts. */
  tenant: MicrosoftTenantSchema.optional(),
})

const ConsentSchema = ParamsSchema.extend({
  email: z.string().max(320).default(''),
  subject: z.string().max(200).default(''),
  tenant_id: z.string().max(36).default(''),
  object_id: z.string().max(36).default(''),
  given_name: z.string().max(100).default(''),
  family_name: z.string().max(100).default(''),
  unverified: z.string().optional(),
  action: z.enum(['allow', 'deny']).default('allow'),
})

const NAMES = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
} as const

/** The organization the mock's Microsoft accounts are in when nothing else is said. */
export const MOCK_MICROSOFT_TENANT_ID = '11111111-2222-4333-8444-555555555555'

/** The tenant id the consent page offers: one the environment's `tenant` accepts. */
function defaultTenantId(tenant: string | undefined): string {
  if (tenant === 'consumers') {
    return MICROSOFT_CONSUMER_TENANT_ID
  }
  return isGuid(tenant) ? tenant : MOCK_MICROSOFT_TENANT_ID
}

/** A GUID that is stable per seed, so signing in again finds the same identity. */
function guidOf(seed: string): string {
  const hex = sha256Hex(seed)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * The account id of an address when none is typed. Discord's is a snowflake and X's and
 * Facebook's are decimal ids too (here sixty bits of the address's hash), as the real
 * adapters accept nothing else.
 */
function derivedSubject(provider: string, normalizedEmail: string): string {
  const hex = sha256Hex(normalizedEmail)
  return provider === 'discord' || provider === 'x' || provider === 'facebook'
    ? String(BigInt(`0x${hex.slice(0, 15)}`) + 1n)
    : `mock-${hex.slice(0, 24)}`
}

const ACCOUNT_FIELDS =
  '<label for="subject">Account id (optional; derived from the email when empty)</label>' +
  '<input id="subject" name="subject" type="text" autocomplete="off">'

function microsoftFields(tenant: string | undefined): string {
  return (
    '<label for="tenant_id">Tenant id (tid)</label>' +
    `<input id="tenant_id" name="tenant_id" type="text" autocomplete="off" value="${escapeHtml(defaultTenantId(tenant))}">` +
    '<label for="object_id">Object id (oid; optional, derived from the email when empty)</label>' +
    '<input id="object_id" name="object_id" type="text" autocomplete="off">'
  )
}

const STYLE =
  'body{font-family:system-ui,sans-serif;max-width:26rem;margin:8vh auto;padding:0 1rem;color:#1a1a1a;background:#fff}' +
  'label{display:block;margin:.75rem 0 .25rem;font-weight:600}' +
  'input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:.5rem;font:inherit;border:1px solid #6b6b6b;border-radius:6px}' +
  'button{font:inherit;padding:.55rem 1rem;border-radius:6px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;margin:1rem .5rem 0 0;cursor:pointer}' +
  'button.secondary{background:#fff;color:#1a1a1a}' +
  '.note{background:#fff4ce;border:1px solid #8a6d00;padding:.5rem .75rem;border-radius:6px}'

function page(c: Context<AppEnv>, body: string, status: 200 | 400 = 200): Response {
  c.header('Cache-Control', 'no-store')
  // No `form-action`: browsers apply it to the redirects that follow a form post as well, and
  // this form's post ends, through the API's callback, on the app's own origin.
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  return c.html(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>Mock sign-in provider</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    status
  )
}

const refused = (c: Context<AppEnv>) =>
  page(c, '<h1>Mock sign-in provider</h1><p>This request is not valid.</p>', 400)

router.use(async (c, next) => {
  const { config } = c.get('deps')
  if (!config.oauthMock || config.tier !== 'local') {
    return c.notFound()
  }
  await next()
})

router.get('/authorize', (c) => {
  const parsed = ParamsSchema.safeParse(c.req.query())
  // An open redirector otherwise: the only place this page ever sends a browser is this API's
  // own callback for the provider.
  if (
    !parsed.success ||
    parsed.data.redirect_uri !== OAuth.callbackUrl(c.get('deps').config, parsed.data.provider)
  ) {
    return refused(c)
  }
  const hidden = Object.entries(parsed.data)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('')
  const name = NAMES[parsed.data.provider]
  const microsoft = parsed.data.provider === 'microsoft'
  return page(
    c,
    `<h1>Mock ${name} sign-in</h1>` +
      '<p class="note"><strong>Development only.</strong> This page stands in for ' +
      `${name}. It exists only with ENVIRONMENT=local and OAUTH_MOCK_PROVIDER=true.</p>` +
      `<form method="post" action="/v1/dev/oauth/authorize">${hidden}` +
      `<label for="email">${
        givesNoAddress(parsed.data.provider)
          ? `Email address (never read from ${name}: it only derives an account id)`
          : 'Email address the provider reports'
      }</label>` +
      '<input id="email" name="email" type="email" autocomplete="off">' +
      (microsoft ? microsoftFields(parsed.data.tenant) : ACCOUNT_FIELDS) +
      '<label for="given_name">First name (optional)</label>' +
      '<input id="given_name" name="given_name" type="text" autocomplete="off">' +
      '<label for="family_name">Last name (optional)</label>' +
      '<input id="family_name" name="family_name" type="text" autocomplete="off">' +
      '<p><label style="font-weight:400"><input type="checkbox" name="unverified" value="1"> ' +
      `${
        microsoft
          ? 'Leave out the verified-domain claim (xms_edov): the address is unverified'
          : 'Report the email as unverified'
      }</label></p>` +
      '<button type="submit" name="action" value="allow">Continue</button>' +
      '<button type="submit" name="action" value="deny" class="secondary">Cancel</button>' +
      '</form>'
  )
})

router.post('/authorize', async (c) => {
  let form: Record<string, unknown> = {}
  try {
    form = await c.req.parseBody()
  } catch {
    // Handled as an invalid request below.
  }
  const parsed = ConsentSchema.safeParse(form)
  const deps = c.get('deps')
  if (
    !parsed.success ||
    !(OAUTH_PROVIDERS as readonly string[]).includes(parsed.data.provider) ||
    parsed.data.redirect_uri !== OAuth.callbackUrl(deps.config, parsed.data.provider)
  ) {
    return refused(c)
  }
  const consent = parsed.data
  const callback = new URL(consent.redirect_uri)
  callback.searchParams.set('state', consent.state)
  if (consent.action === 'deny') {
    callback.searchParams.set('error', 'access_denied')
    return c.redirect(callback.toString(), 302)
  }
  const email = parseEmail(consent.email)
  // Stable per address, so signing in again finds the same identity. Microsoft's is the pair
  // of ids its tokens carry, built as the real adapter builds it.
  const subject =
    consent.provider === 'microsoft'
      ? email || consent.object_id !== ''
        ? microsoftSubject(
            consent.tenant_id || defaultTenantId(consent.tenant),
            consent.object_id || guidOf(email?.normalized ?? '')
          )
        : null
      : consent.subject || (email ? derivedSubject(consent.provider, email.normalized) : null)
  if (subject === null) {
    return refused(c)
  }
  const verified = email !== null && consent.unverified === undefined
  callback.searchParams.set(
    'code',
    await issueMockCode(deps.secretBox, deps.clock, {
      provider: consent.provider,
      clientId: consent.client_id,
      redirectUri: consent.redirect_uri,
      nonce: consent.nonce,
      codeChallenge: consent.code_challenge,
      profile: {
        subject,
        email: email?.email ?? null,
        emailVerified: verified,
        ...(consent.given_name && { givenName: consent.given_name }),
        ...(consent.family_name && { familyName: consent.family_name }),
      },
      // LinkedIn's address and name are its userinfo answer's, in LinkedIn's own field names:
      // the mock adapter reads them from here and nowhere else, as the real one does.
      ...(consent.provider === 'linkedin' && {
        userinfo: {
          sub: subject,
          ...(email && { email: email.email, email_verified: verified }),
          ...(consent.given_name && { given_name: consent.given_name }),
          ...(consent.family_name && { family_name: consent.family_name }),
        },
      }),
    })
  )
  return c.redirect(callback.toString(), 302)
})

const IdTokenSchema = z.strictObject({
  provider: IdTokenProviderSchema,
  /** The client id the token is "issued for". Whatever the caller asks: another app's too. */
  audience: z.string().min(1).max(512),
  /** The client that "asked", when it is not the audience. */
  authorizedParty: z.string().min(1).max(512).optional(),
  /** The nonce the token carries. Left out, the token has none. */
  nonce: z.string().min(1).max(512).optional(),
  email: z.string().max(320).optional(),
  subject: z.string().min(1).max(200).optional(),
  unverified: z.boolean().optional(),
  givenName: z.string().max(100).optional(),
  familyName: z.string().max(100).optional(),
  /** Mint a token whose expiry has already passed. */
  expired: z.boolean().optional(),
})

/**
 * Mint the ID token a native app would have been handed by the provider's SDK (ADR 0045):
 * what the consent page is to a browser's round trip. **It signs a token for any address
 * and any audience**, which is what it is for, and why it exists only where the mock
 * provider does (the guard above) and only for tools on this machine: a request that
 * carries an `Origin`, that a browser marks as coming from another site, or whose `Host`
 * does not name this machine is refused, as the development SMS inbox refuses it. A page a
 * developer has open cannot ask for a token, and neither can one that reaches this port by
 * DNS rebinding. Outside the OpenAPI document: it is not part of the contract.
 */
router.post('/id-token', async (c) => {
  if (!isLoopbackHost(c.req.header('host'))) {
    // Nothing in the body: whoever asked under another name is told nothing at all.
    return c.body(null, 403)
  }
  const site = c.req.header('sec-fetch-site')
  if (
    c.req.header('origin') !== undefined ||
    (site !== undefined && site !== 'none' && site !== 'same-origin')
  ) {
    throw new ForbiddenError()
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const parsed = IdTokenSchema.safeParse(body)
  const email = parsed.success && parsed.data.email ? parseEmail(parsed.data.email) : null
  const subject = parsed.success
    ? (parsed.data.subject ??
      (email ? derivedSubject(parsed.data.provider, email.normalized) : null))
    : null
  if (!parsed.success || subject === null) {
    return c.json({ error: 'invalid request' }, 400)
  }
  const asked = parsed.data
  const deps = c.get('deps')
  c.header('Cache-Control', 'no-store')
  return c.json({
    idToken: await issueMockIdToken(
      deps.secretBox,
      deps.clock,
      asked.provider,
      {
        aud: asked.audience,
        ...(asked.authorizedParty !== undefined && { azp: asked.authorizedParty }),
        sub: subject,
        ...(asked.nonce !== undefined && { nonce: asked.nonce }),
        ...(email && { email: email.email, email_verified: asked.unverified !== true }),
        ...(asked.givenName && { given_name: asked.givenName }),
        ...(asked.familyName && { family_name: asked.familyName }),
      },
      { expired: asked.expired === true }
    ),
  })
})

export default router
