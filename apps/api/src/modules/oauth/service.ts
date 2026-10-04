import {
  AT_LEAST_ONE_SIGN_IN_METHOD,
  type EnvironmentSettings,
  type FirstFactorStrategy,
  hasEnabledSignInMethod,
  type Identity,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type OAuthProviderSettings,
  type OAuthProviderUpdate,
} from '@tula/contract'
import type { AppConfig, Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError, ValidationError } from '~/exceptions'
import type { Actor, Origin } from '~/lib/actor'
import { cleanOrigin } from '~/lib/actor'
import { parseEmail } from '~/lib/email'
import * as logger from '~/lib/logger'
import { isEcP256PrivateKey } from '~/lib/pkcs8'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Settings from '~/modules/settings/service'
import type { OAuthCredentials, OAuthProfile } from '~/ports/oauth-provider'
import type { OAuthProviderRecord } from '~/ports/oauth-provider-store'
import type { IdentityRecord, SignInMeans, UserRecord } from '~/ports/user-repository'

/** Secret-box purpose of provider credentials: a key of their own, apart from every other secret. */
export const OAUTH_SECRET_PURPOSE = 'oauth-credentials'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/**
 * The redirect URI an operator pastes into a provider's console: this API's callback.
 *
 * The callback is on the API, not on the app, so that the authorization code never passes
 * through the app's pages and one URI serves every app of the environment (ADR 0026).
 *
 * @param config - The deployment's configuration (`PUBLIC_URL`).
 * @param provider - The provider.
 * @returns `PUBLIC_URL/v1/oauth/callback/<provider>`.
 *
 * @example
 * ```ts
 * callbackUrl(deps.config, 'google') // 'https://auth.example.com/v1/oauth/callback/google'
 * ```
 */
export function callbackUrl(config: Pick<AppConfig, 'publicUrl'>, provider: OAuthProvider): string {
  return `${config.publicUrl.replace(/\/+$/, '')}/v1/oauth/callback/${provider}`
}

/**
 * The first-factor strategy a provider is offered as.
 *
 * @param provider - The provider.
 * @returns `oauth_<provider>`.
 */
export function strategyOf(provider: OAuthProvider): FirstFactorStrategy {
  return `oauth_${provider}`
}

/** What binds a sealed secret to its row: copied to another environment or provider, it fails. */
function aad(environmentId: string, provider: OAuthProvider): string {
  return `${environmentId}:${provider}`
}

/** The secret part of a provider's credentials, as it is sealed. */
type SecretMaterial = Pick<OAuthCredentials, 'clientSecret' | 'privateKey'>

async function open(
  deps: Pick<Deps, 'secretBox'>,
  record: OAuthProviderRecord
): Promise<OAuthCredentials> {
  const sealed = await deps.secretBox.open(
    OAUTH_SECRET_PURPOSE,
    record.secret,
    aad(record.environmentId, record.provider)
  )
  const secret = JSON.parse(new TextDecoder().decode(sealed)) as SecretMaterial
  return { clientId: record.clientId, ...record.config, ...secret }
}

/**
 * The OAuth providers an environment offers at sign-in: configured **and** enabled.
 *
 * Depends on the environment alone, never on an identifier or an account, like every other
 * first factor.
 *
 * @param deps - Provider store.
 * @param tenant - The environment.
 * @returns The providers, in the order of `OAUTH_PROVIDERS`.
 */
export async function enabledProviders(
  deps: Pick<Deps, 'oauthProviders'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<OAuthProvider[]> {
  const enabled = new Set(
    (await deps.oauthProviders.list(tenant.environmentId))
      .filter((record) => record.enabled)
      .map((record) => record.provider)
  )
  return OAUTH_PROVIDERS.filter((provider) => enabled.has(provider))
}

/**
 * An environment's credentials for a provider it has enabled.
 *
 * Checked on every step that uses the provider (start, callback, exchange), so a provider
 * switched off while an attempt is under way stops working at once.
 *
 * @param deps - Provider store and secret box.
 * @param tenant - The environment.
 * @param provider - The provider.
 * @returns The opened credentials. Never log or return them.
 * @throws AuthError `auth.method_disabled` when the provider is not configured, not enabled, or
 *   its stored secret does not open (a changed master key): the method is unusable either way.
 */
export async function credentials(
  deps: Pick<Deps, 'oauthProviders' | 'secretBox'>,
  tenant: Pick<Tenant, 'environmentId'>,
  provider: OAuthProvider
): Promise<OAuthCredentials> {
  const record = await deps.oauthProviders.find(tenant.environmentId, provider)
  if (!record?.enabled) {
    throw new AuthError('auth.method_disabled', { method: strategyOf(provider) })
  }
  try {
    return await open(deps, record)
  } catch (error) {
    logger.error('stored OAuth credentials could not be opened', {
      environmentId: tenant.environmentId,
      provider,
      err: error instanceof Error ? error.name : 'unknown',
    })
    throw new AuthError('auth.method_disabled', { method: strategyOf(provider) })
  }
}

function toSettings(
  config: Pick<AppConfig, 'publicUrl'>,
  provider: OAuthProvider,
  record: OAuthProviderRecord | undefined
): OAuthProviderSettings {
  return {
    provider,
    configured: record !== undefined,
    enabled: record?.enabled ?? false,
    clientId: record?.clientId ?? null,
    teamId: record?.config.teamId ?? null,
    keyId: record?.config.keyId ?? null,
    callbackUrl: callbackUrl(config, provider),
    updatedAt: record?.updatedAt.toISOString() ?? null,
  }
}

/**
 * Every provider as an administrator sees it: whether it is configured and enabled, its client
 * id, and the callback URL to paste into the provider's console. **Never a secret.**
 *
 * @param deps - Provider store and config.
 * @param tenant - The environment.
 * @returns One entry per provider, configured or not.
 */
export async function list(
  deps: Pick<Deps, 'oauthProviders' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<OAuthProviderSettings[]> {
  const records = await deps.oauthProviders.list(tenant.environmentId)
  return OAUTH_PROVIDERS.map((provider) =>
    toSettings(
      deps.config,
      provider,
      records.find((record) => record.provider === provider)
    )
  )
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError({ errors: [{ field, code: 'validation.failed', message }] })
}

/** The fields each provider takes besides `clientId` and `enabled`. */
const PROVIDER_FIELDS = {
  google: { secret: 'clientSecret', config: [] },
  github: { secret: 'clientSecret', config: [] },
  apple: { secret: 'privateKey', config: ['teamId', 'keyId'] },
} as const satisfies Record<
  OAuthProvider,
  { secret: keyof SecretMaterial; config: readonly ('teamId' | 'keyId')[] }
>

const CREDENTIAL_FIELDS = ['clientSecret', 'privateKey', 'teamId', 'keyId'] as const

/**
 * Refuse a change that would leave an environment with no way to sign in: its settings enable
 * no method of their own, and this change takes its last enabled provider away. (The other
 * half of the rule is in `Settings.replace`.)
 */
async function requireWayIn(
  deps: Pick<Deps, 'oauthProviders' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  provider: OAuthProvider
): Promise<void> {
  if (hasEnabledSignInMethod((await Settings.get(deps, tenant, true)).settings)) {
    return
  }
  const others = (await enabledProviders(deps, tenant)).filter((other) => other !== provider)
  if (others.length === 0) {
    throw fieldError('enabled', AT_LEAST_ONE_SIGN_IN_METHOD)
  }
}

/**
 * Set a provider's credentials and whether sign-in offers it.
 *
 * The secret (a client secret, or Apple's private key) is sealed with the secret box, bound to
 * the environment and the provider, before it is stored, and is never returned or logged. It may
 * be left out when the provider is already configured: the stored one is kept. Apple's key is
 * checked to be a P-256 private key, so a wrong file is refused here instead of failing every
 * sign-in later.
 *
 * Recorded as `oauth_provider.updated` in the same transaction, with the provider and the
 * **names** of what changed (`secret` among them), never a value.
 *
 * @param deps - Provider store, secret box, settings, ids and clock.
 * @param tenant - The environment.
 * @param provider - The provider.
 * @param input - Client id, secret material and whether it is enabled.
 * @param actor - Who is changing it, for the audit log.
 * @returns The provider as an administrator sees it.
 * @throws ValidationError (422) on a missing or unusable field, a field the provider does not
 *   take, or `enabled: false` when that leaves the environment with no way to sign in.
 */
export async function update(
  deps: Pick<
    Deps,
    'oauthProviders' | 'secretBox' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  tenant: Scope,
  provider: OAuthProvider,
  input: OAuthProviderUpdate,
  actor: Actor
): Promise<OAuthProviderSettings> {
  const fields = PROVIDER_FIELDS[provider]
  const taken: readonly string[] = [fields.secret, ...fields.config]
  for (const field of CREDENTIAL_FIELDS) {
    if (input[field] !== undefined && !taken.includes(field)) {
      throw fieldError(field, `${field} is not used by this provider`)
    }
  }
  for (const field of fields.config) {
    if (input[field] === undefined) {
      throw fieldError(field, `${field} is required for this provider`)
    }
  }
  const existing = await deps.oauthProviders.find(tenant.environmentId, provider)
  const secret = input[fields.secret]
  if (secret === undefined && !existing) {
    throw fieldError(fields.secret, `${fields.secret} is required`)
  }
  if (provider === 'apple' && secret !== undefined && !(await isEcP256PrivateKey(secret))) {
    throw fieldError('privateKey', 'privateKey must be the PKCS#8 PEM of a P-256 private key')
  }
  if (existing?.enabled && !input.enabled) {
    await requireWayIn(deps, tenant, provider)
  }

  const now = deps.clock.now()
  const config = { teamId: input.teamId, keyId: input.keyId }
  const changed = [
    ...(existing?.clientId !== input.clientId ? ['clientId'] : []),
    ...(secret !== undefined ? ['secret'] : []),
    ...fields.config.filter((field) => existing?.config[field] !== config[field]),
    ...(existing?.enabled !== input.enabled ? ['enabled'] : []),
  ]
  const record: OAuthProviderRecord = {
    id: existing?.id ?? deps.ids.next(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    provider,
    clientId: input.clientId,
    secret:
      secret === undefined
        ? (existing as OAuthProviderRecord).secret
        : await deps.secretBox.seal(
            OAUTH_SECRET_PURPOSE,
            new TextEncoder().encode(JSON.stringify({ [fields.secret]: secret })),
            aad(tenant.environmentId, provider)
          ),
    config: Object.fromEntries(fields.config.map((field) => [field, config[field]])),
    enabled: input.enabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const stored = await deps.oauthProviders.upsert(
    record,
    Audit.entry(deps, tenant, {
      type: 'oauth_provider.updated',
      actor,
      target: { type: 'environment', id: tenant.environmentId },
      data: { provider, changed, ...(!existing && { created: true }) },
    })
  )
  return toSettings(deps.config, provider, stored)
}

/**
 * Remove a provider's credentials.
 *
 * Users keep their identities of that provider: configuring it again lets them back in. The
 * removal is **not** refused because some user has no other way to sign in. Deciding that would
 * mean reading every user, and such a user is not locked out for good (a password reset sets a
 * first password; an administrator can set one). It **is** refused when it would leave the
 * whole environment with no sign-in method.
 *
 * @param deps - Provider store, settings, ids and clock.
 * @param tenant - The environment.
 * @param provider - The provider.
 * @param actor - Who is removing it, for the audit log.
 * @throws NotFoundError when the provider is not configured.
 * @throws ValidationError (422) when no way to sign in would remain.
 */
export async function remove(
  deps: Pick<Deps, 'oauthProviders' | 'environmentSettings' | 'config' | 'ids' | 'clock'>,
  tenant: Scope,
  provider: OAuthProvider,
  actor: Actor
): Promise<void> {
  const existing = await deps.oauthProviders.find(tenant.environmentId, provider)
  if (!existing) {
    throw new NotFoundError()
  }
  if (existing.enabled) {
    await requireWayIn(deps, tenant, provider)
  }
  const deleted = await deps.oauthProviders.delete(
    tenant.environmentId,
    provider,
    Audit.entry(deps, tenant, {
      type: 'oauth_provider.deleted',
      actor,
      target: { type: 'environment', id: tenant.environmentId },
      data: { provider },
    })
  )
  if (!deleted) {
    throw new NotFoundError()
  }
}

/** The account a proven provider identity belongs to, and how it came to. */
export interface ResolvedAccount {
  user: UserRecord
  /** The account was created by this sign-in. */
  created: boolean
  /** The identity was connected to an existing account by this sign-in. */
  linked: boolean
}

type AccountDeps = Pick<
  Deps,
  'users' | 'ids' | 'clock' | 'mailer' | 'environmentSettings' | 'config' | 'rateLimiter'
>

/**
 * Decide which account a provider identity signs in to. **This is where takeovers happen**, so
 * every row of the table is deliberate (ADR 0026):
 *
 * 1. **The identity (provider + subject) is already a user's** → that user. The provider's email
 *    is not looked at: a changed provider address neither changes the Tula address nor moves
 *    the identity to whoever now has it.
 * 2. **The provider shared no address, or does not assert it verified** → refused
 *    (`oauth.email_missing`, `oauth.email_unverified`), **before** the address is looked up, so
 *    an unverified address can neither create an account nor reveal whether one exists.
 * 3. **No user has that address** → a new user with the identity, the address marked verified
 *    (the provider vouches for it) and no password.
 * 4. **A user has that address, and it is verified on their Tula account** → the identity is
 *    connected to them and they sign in (a second factor still applies afterwards). Both sides
 *    have proven the same inbox.
 * 5. **A user has that address, unverified on their Tula account** → refused with
 *    `oauth.account_exists` and nothing is connected. An unverified Tula account may have been
 *    created by someone who does not own the address, precisely to be "linked into" later.
 *    The code tells the caller an account exists; the caller has proven to the provider that
 *    the address is theirs, so they are told nothing they could not learn from their own inbox.
 *
 * The unique keys are the arbiter under concurrency: a create or link that loses a race is
 * looked at again, once, and ends in row 1.
 *
 * @param deps - User repository, ids, clock and what a notice needs.
 * @param tenant - The environment.
 * @param provider - The provider that vouched.
 * @param profile - What it said.
 * @param origin - The request, for the audit entries.
 * @returns The account.
 * @throws AuthError `oauth.email_missing`, `oauth.email_unverified`, `oauth.account_exists`,
 *   `auth.user_banned` (a banned user is not connected to anything), or `flow.invalid_step`
 *   when two rounds both lost a race.
 */
export async function resolveAccount(
  deps: AccountDeps,
  tenant: Scope,
  provider: OAuthProvider,
  profile: OAuthProfile,
  origin: Partial<Origin>
): Promise<ResolvedAccount> {
  const { environmentId } = tenant
  for (let round = 0; round < 2; round += 1) {
    const known = await deps.users.findByIdentity(environmentId, provider, profile.subject)
    if (known) {
      return { user: known, created: false, linked: false }
    }
    const parsed = profile.email === null ? null : parseEmail(profile.email)
    if (!parsed) {
      throw new AuthError('oauth.email_missing')
    }
    if (!profile.emailVerified) {
      throw new AuthError('oauth.email_unverified')
    }
    const now = deps.clock.now()
    const owner = await deps.users.findByEmail(environmentId, parsed.normalized)
    if (!owner) {
      const userId = deps.ids.next()
      const created = await deps.users.create(
        {
          id: userId,
          projectId: tenant.projectId,
          environmentId,
          email: parsed.email,
          emailNormalized: parsed.normalized,
          emailVerifiedAt: now,
          firstName: profile.givenName ?? null,
          lastName: profile.familyName ?? null,
          createdAt: now,
          identityId: deps.ids.next(),
          credentialId: deps.ids.next(),
          passwordHash: null,
          oauthIdentity: { id: deps.ids.next(), provider, subject: profile.subject },
        },
        Audit.entry(deps, tenant, {
          type: 'user.created',
          actor: { type: 'user', id: userId, ...cleanOrigin(origin) },
          target: { type: 'user', id: userId },
          data: { method: strategyOf(provider), emailVerified: true, passwordless: true },
        })
      )
      const user = created ? await deps.users.findById(environmentId, userId) : null
      if (user) {
        return { user, created: true, linked: false }
      }
      continue
    }
    if (owner.emailVerifiedAt === null) {
      throw new AuthError('oauth.account_exists')
    }
    if (owner.bannedAt !== null) {
      throw new AuthError('auth.user_banned')
    }
    const outcome = await deps.users.linkIdentity(
      {
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId,
        userId: owner.id,
        provider,
        subject: profile.subject,
        createdAt: now,
      },
      Audit.entry(deps, tenant, {
        type: 'user.identity_linked',
        actor: { type: 'user', id: owner.id, ...cleanOrigin(origin) },
        target: { type: 'user', id: owner.id },
        data: { provider, method: 'auto' },
      }),
      { emailNormalized: parsed.normalized }
    )
    if (outcome === 'linked') {
      Notices.identityChanged(deps, tenant, owner, { change: 'linked', provider, at: now })
      return { user: owner, created: false, linked: true }
    }
    if (outcome === 'provider_linked') {
      // The account already has another account of this provider: not this one's to replace.
      throw new AuthError('oauth.account_exists')
    }
    // `identity_in_use` or `user_changed`: another request got there first. Look again.
  }
  throw new AuthError('flow.invalid_step')
}

function toIdentity(identity: IdentityRecord): Identity {
  return {
    id: identity.id,
    provider: identity.provider,
    createdAt: identity.createdAt.toISOString(),
  }
}

/**
 * The provider accounts connected to a user.
 *
 * @param deps - User repository.
 * @param tenant - The environment.
 * @param userId - The signed-in user.
 * @returns Their identities, oldest first. Never a provider's own id for the account.
 */
export async function identities(
  deps: Pick<Deps, 'users'>,
  tenant: Pick<Tenant, 'environmentId'>,
  userId: string
): Promise<Identity[]> {
  return (await deps.users.listIdentities(tenant.environmentId, userId)).map(toIdentity)
}

/**
 * Connect a proven provider identity to the signed-in user who asked for it.
 *
 * Unlike an automatic link this does not look at the provider's email at all: the user is
 * signed in (and has recently proven it), and the provider has just vouched for the account.
 * The identity goes to **that** user or to nobody.
 *
 * @param deps - User repository, ids, clock and what a notice needs.
 * @param tenant - The environment.
 * @param userId - The signed-in user the link attempt was started for.
 * @param provider - The provider that vouched.
 * @param profile - What it said.
 * @param actor - The user with the request's origin.
 * @returns The connected identity.
 * @throws AuthError `oauth.identity_in_use` when the provider account belongs to another user,
 *   `oauth.already_linked` when the user already has an account of this provider, or
 *   `auth.unauthenticated` when the user no longer exists.
 */
export async function link(
  deps: AccountDeps,
  tenant: Scope,
  userId: string,
  provider: OAuthProvider,
  profile: OAuthProfile,
  actor: Actor
): Promise<Identity> {
  const identity = {
    id: deps.ids.next(),
    userId,
    provider,
    subject: profile.subject,
    createdAt: deps.clock.now(),
  }
  const outcome = await deps.users.linkIdentity(
    { ...identity, projectId: tenant.projectId, environmentId: tenant.environmentId },
    Audit.entry(deps, tenant, {
      type: 'user.identity_linked',
      actor,
      target: { type: 'user', id: userId },
      data: { provider, method: 'profile' },
    })
  )
  if (outcome === 'linked') {
    const user = await deps.users.findById(tenant.environmentId, userId)
    if (user) {
      Notices.identityChanged(deps, tenant, user, {
        change: 'linked',
        provider,
        at: identity.createdAt,
      })
    }
    return toIdentity(identity)
  }
  if (outcome === 'user_changed') {
    throw new AuthError('auth.unauthenticated')
  }
  if (outcome === 'provider_linked') {
    throw new AuthError('oauth.already_linked')
  }
  // The same request repeated lands here too: the identity is already this user's.
  const mine = (await deps.users.listIdentities(tenant.environmentId, userId)).find(
    (other) => other.provider === provider && other.subject === profile.subject
  )
  if (mine) {
    return toIdentity(mine)
  }
  throw new AuthError('oauth.identity_in_use')
}

/**
 * Whether a user could still sign in with what they would have left. **The one definition** of
 * "a way to sign in", used to refuse removing the last one:
 *
 * - a password, where the environment has the password method on;
 * - a verified email address, where the environment has the email code on (the emailed link
 *   needs the code, so it adds nothing);
 * - another connected provider account, where the environment has that provider enabled.
 *
 * A method the environment has switched off does not count: it would not let the user in.
 * (A password reset could still give such a user a first password where passwords are on; that
 * is a recovery path, not a way to sign in, and is not counted.)
 *
 * @param settings - The environment's settings.
 * @param providers - The OAuth providers the environment has enabled.
 * @param remaining - What the user would have left.
 * @returns `true` when at least one way remains.
 *
 * @example
 * ```ts
 * canStillSignIn(settings, ['google'], { hasPassword: false, emailVerified: true, providers: [] })
 * ```
 */
export function canStillSignIn(
  settings: EnvironmentSettings,
  providers: readonly OAuthProvider[],
  remaining: SignInMeans
): boolean {
  const { methods } = settings.signIn
  return (
    (remaining.hasPassword && methods.password.enabled) ||
    (remaining.emailVerified && methods.emailCode.enabled) ||
    remaining.providers.some((provider) => providers.includes(provider))
  )
}

/**
 * Disconnect a provider account from the signed-in user.
 *
 * Refused when it would remove their last way to sign in ({@link canStillSignIn}); the check
 * runs inside the store's transaction, so two removals at once cannot each rely on the other's
 * identity remaining. Recorded as `user.identity_unlinked`, and the owner is told.
 *
 * @param deps - User repository, settings, provider store, ids, clock and what a notice needs.
 * @param tenant - The environment.
 * @param userId - The signed-in user.
 * @param identityId - The identity to remove.
 * @param actor - The user with the request's origin.
 * @throws NotFoundError when the user has no such identity.
 * @throws AuthError `identity.last_sign_in_method` when nothing else would let them in.
 */
export async function unlink(
  deps: AccountDeps & Pick<Deps, 'oauthProviders'>,
  tenant: Scope,
  userId: string,
  identityId: string,
  actor: Actor
): Promise<void> {
  const identity = (await deps.users.listIdentities(tenant.environmentId, userId)).find(
    (candidate) => candidate.id === identityId
  )
  if (!identity) {
    throw new NotFoundError()
  }
  const settings = await Settings.current(deps, tenant)
  const providers = await enabledProviders(deps, tenant)
  const outcome = await deps.users.unlinkIdentity(
    tenant.environmentId,
    userId,
    identityId,
    (remaining) => canStillSignIn(settings, providers, remaining),
    Audit.entry(deps, tenant, {
      type: 'user.identity_unlinked',
      actor,
      target: { type: 'user', id: userId },
      data: { provider: identity.provider },
    })
  )
  if (outcome === 'not_found') {
    throw new NotFoundError()
  }
  if (outcome === 'last_method') {
    throw new AuthError('identity.last_sign_in_method')
  }
  const user = await deps.users.findById(tenant.environmentId, userId)
  if (user) {
    Notices.identityChanged(deps, tenant, user, {
      change: 'unlinked',
      provider: identity.provider,
      at: deps.clock.now(),
    })
  }
}
