import { Hono } from 'hono'
import { exportJWK, importPKCS8, type JWK, SignJWT } from 'jose'
import { z } from 'zod'
import { MOCK_SAML_KEY_A } from '~/adapters/oauth/mock-saml-keys'
import type { AppEnv } from '~/dependencies'
import { isLoopbackHost } from '~/env'
import { ForbiddenError } from '~/exceptions'
import { timingSafeEqual } from '~/lib/crypto'

// The mock enterprise identity provider (ADR 0067): an OpenID Connect provider served by the
// API itself, for development, the conformance scenarios and the SDK journeys. Mounted only
// where the mock OAuth provider is (`OAUTH_MOCK_PROVIDER=true` in the `local` tier, with a
// loopback `PUBLIC_URL`), and every route answers a loopback `Host` only.
//
// Its issuer is `http://<Host>/v1/dev/sso`: a connection whose issuer is that address signs in
// through it, with the real code exchange and the real ID-token checks (fetched through the
// outbound guard, which allows loopback `http` in the `local` tier). The signing key is a
// fixed test key, so that every instance of a deployment publishes the same one. There is no
// consent page: `/authorize` signs in whoever `login_hint` names, at once.

const router = new Hono<AppEnv>()

const KEY_ID = 'tula-mock-sso-1'
const CODE_PURPOSE = 'sso-mock-codes'
const CODE_AAD = 'sso-mock'
/** How long a code and an ID token of the mock stay good. */
const LIFETIME_MS = 5 * 60 * 1000

let signingKey: Promise<{ privateKey: CryptoKey; publicJwk: JWK }> | undefined

function key() {
  signingKey ??= (async () => {
    const privateKey = await importPKCS8(MOCK_SAML_KEY_A.privateKey, 'RS256', {
      extractable: true,
    })
    const { kty, n, e } = await exportJWK(privateKey)
    return { privateKey, publicJwk: { kty, n, e, kid: KEY_ID, alg: 'RS256', use: 'sig' } }
  })()
  return signingKey
}

router.use(async (c, next) => {
  // Through a tunnel this would sign anybody in as anybody: this machine only.
  if (!isLoopbackHost(c.req.header('host'))) {
    throw new ForbiddenError()
  }
  await next()
})

function issuerOf(host: string | undefined): string {
  return `http://${host}/v1/dev/sso`
}

router.get('/.well-known/openid-configuration', (c) => {
  const issuer = issuerOf(c.req.header('host'))
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
  })
})

router.get('/jwks', async (c) => c.json({ keys: [(await key()).publicJwk] }))

const AuthorizeSchema = z.object({
  client_id: z.string().min(1).max(512),
  redirect_uri: z.string().max(2048),
  state: z.string().min(1).max(512),
  nonce: z.string().min(1).max(512),
  code_challenge: z.string().min(1).max(512),
  code_challenge_method: z.literal('S256'),
  /** The address to sign in as. */
  login_hint: z.string().min(3).max(320),
  /** The account's id at the provider; the address when left out. */
  subject: z.string().min(1).max(200).optional(),
  /** Present: the token says `email_verified: false`. */
  unverified: z.string().optional(),
})

const GrantSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  challenge: z.string(),
  nonce: z.string(),
  email: z.string(),
  subject: z.string(),
  verified: z.boolean(),
  expiresAt: z.number(),
})

router.get('/authorize', async (c) => {
  const parsed = AuthorizeSchema.safeParse(c.req.query())
  const deps = c.get('deps')
  // Only to this API's own SSO callback: the mock is no open redirector.
  if (
    !parsed.success ||
    !parsed.data.redirect_uri.startsWith(`${deps.config.publicUrl}/v1/sso/callback/`)
  ) {
    return c.text('The mock identity provider could not read the request.', 400)
  }
  const asked = parsed.data
  const grant: z.infer<typeof GrantSchema> = {
    clientId: asked.client_id,
    redirectUri: asked.redirect_uri,
    challenge: asked.code_challenge,
    nonce: asked.nonce,
    email: asked.login_hint,
    subject: asked.subject ?? asked.login_hint.toLowerCase(),
    verified: asked.unverified === undefined,
    expiresAt: deps.clock.now().getTime() + LIFETIME_MS,
  }
  const code = await deps.secretBox.seal(
    CODE_PURPOSE,
    new TextEncoder().encode(JSON.stringify(grant)),
    CODE_AAD
  )
  const back = new URL(asked.redirect_uri)
  back.search = new URLSearchParams({ code, state: asked.state }).toString()
  return c.redirect(back.toString(), 303)
})

router.post('/token', async (c) => {
  const deps = c.get('deps')
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : '')
  const refuse = () => c.json({ error: 'invalid_grant' }, 400)
  let grant: z.infer<typeof GrantSchema>
  try {
    const opened = await deps.secretBox.open(CODE_PURPOSE, field('code'), CODE_AAD)
    grant = GrantSchema.parse(JSON.parse(new TextDecoder().decode(opened)))
  } catch {
    return refuse()
  }
  const challenge = new Bun.CryptoHasher('sha256')
    .update(field('code_verifier'))
    .digest('base64url')
  if (
    field('grant_type') !== 'authorization_code' ||
    field('client_id') !== grant.clientId ||
    field('client_secret') === '' ||
    field('redirect_uri') !== grant.redirectUri ||
    !timingSafeEqual(challenge, grant.challenge) ||
    grant.expiresAt <= deps.clock.now().getTime()
  ) {
    return refuse()
  }
  const now = Math.floor(deps.clock.now().getTime() / 1000)
  const idToken = await new SignJWT({
    email: grant.email,
    email_verified: grant.verified,
    nonce: grant.nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuerOf(c.req.header('host')))
    .setAudience(grant.clientId)
    .setSubject(grant.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + LIFETIME_MS / 1000)
    .sign((await key()).privateKey)
  return c.json({ access_token: 'mock', token_type: 'Bearer', id_token: idToken })
})

export default router
