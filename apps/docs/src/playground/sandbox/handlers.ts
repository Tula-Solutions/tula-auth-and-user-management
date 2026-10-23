import type { OperationId, Schemas } from './api-types'
import { SandboxError } from './errors'
import {
  type Answer,
  advance,
  afterEmailOrFactor,
  afterFirstFactor,
  assertPolicy,
  attemptBody,
  authenticate,
  type Context,
  checkCode,
  checkSecondFactor,
  currentUser,
  email,
  finish,
  firstFactors,
  loadAttempt,
  newBackupCodes,
  oauthStrategy,
  redirect,
  requireStep,
  SANDBOX_ORIGIN,
  secondFactorsFor,
  sendCode,
  startAttempt,
  text,
  tokensFor,
  userByEmail,
} from './helpers'
import { matchTotp } from './totp'
import type { SandboxAttempt, SandboxProvider, SandboxUser } from './types'
import { newTotpSecret, normalizeEmail, SANDBOX_PASSWORD_POLICY, type World } from './world'

// The in-browser API: one handler for every operation of the client API, typed with the
// generated types, so an operation the contract adds does not compile until this table
// answers it, and an answer that does not fit the contract's shape does not compile either.
// What the sandbox does not simulate is listed in `UNSUPPORTED` with the reason, and answers
// with the contract's own refusal for it.

type Handlers = {
  [Id in OperationId]: (ctx: Context<Id>) => Answer<Id> | Promise<Answer<Id>>
}

/**
 * Operations the sandbox answers with a refusal, and why. Each is a feature of the real
 * service that needs a provider, a phone or a clock the playground does not have; the
 * playground says so, and never pretends to run it.
 */
export const UNSUPPORTED: Partial<Record<OperationId, string>> = {
  startIdTokenSignIn: 'native ID-token sign-in needs a provider app on a phone',
  submitSignInIdToken: 'native ID-token sign-in needs a provider app on a phone',
  stepUpSession: 'the sandbox never asks for a recent sign-in',
  sendStepUpEmailCode: 'the sandbox never asks for a recent sign-in',
  sendStepUpSmsCode: 'the sandbox never asks for a recent sign-in',
  getStepUpPasskeyOptions: 'the sandbox never asks for a recent sign-in',
  requestPhoneCode: 'text messages need a phone',
  verifyPhoneNumber: 'text messages need a phone',
  removePhoneNumber: 'text messages need a phone',
  startSmsFactorEnrolment: 'text messages need a phone',
  confirmSmsFactorEnrolment: 'text messages need a phone',
  disableSmsFactor: 'text messages need a phone',
  prepareSignInSecondFactor: 'a texted second factor needs a phone',
  preparePasswordResetSecondFactor: 'a texted second factor needs a phone',
  getSignInSecondFactorPasskeyOptions: 'a passkey as a second factor is not simulated',
  getPasswordResetSecondFactorPasskeyOptions: 'a passkey as a second factor is not simulated',
  submitSignInNewPassword: 'password expiry needs days to pass',
  listMyOrganizations: 'the sandbox has no organizations',
  createMyOrganization: 'the sandbox has no organizations',
  setActiveOrganization: 'the sandbox has no organizations',
  listMyOrganizationSuggestions: 'the sandbox has no organizations',
  joinOrganizationSuggestion: 'the sandbox has no organizations',
  listMyOrganizationDomains: 'the sandbox has no organizations',
  startMyOrganizationDomain: 'the sandbox has no organizations',
  verifyMyOrganizationDomain: 'the sandbox has no organizations',
  updateMyOrganizationDomain: 'the sandbox has no organizations',
  removeMyOrganizationDomain: 'the sandbox has no organizations',
}

/** The refusal an operation in {@link UNSUPPORTED} answers with. */
function unsupported(id: OperationId): never {
  if (id === 'requestPhoneCode' || id === 'verifyPhoneNumber' || id === 'removePhoneNumber') {
    throw new SandboxError('sms.disabled')
  }
  if (
    id === 'listMyOrganizations' ||
    id === 'createMyOrganization' ||
    id === 'setActiveOrganization' ||
    id === 'listMyOrganizationSuggestions' ||
    id === 'joinOrganizationSuggestion' ||
    id === 'listMyOrganizationDomains' ||
    id === 'startMyOrganizationDomain' ||
    id === 'verifyMyOrganizationDomain' ||
    id === 'updateMyOrganizationDomain' ||
    id === 'removeMyOrganizationDomain'
  ) {
    // Organizations are an environment setting the sandbox leaves off.
    throw new SandboxError('organization.disabled')
  }
  throw new SandboxError('auth.method_disabled')
}

function requireMethod(
  world: World,
  ...methods: ('password' | 'emailCode' | 'emailLink' | 'passkey')[]
) {
  for (const method of methods) {
    if (!world.settings.methods[method]) {
      throw new SandboxError('auth.method_disabled', { params: { method } })
    }
  }
}

function userOf(world: World, attempt: SandboxAttempt): SandboxUser {
  const user = world.users.get(attempt.userId ?? '')
  if (!user) {
    throw new SandboxError('flow.invalid_step')
  }
  return user
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

// -- Second factors, inside an attempt (the three kinds of flow share them) ------------------

async function submitSecondFactorStep(
  ctx: Context<'submitSignInSecondFactor' | 'submitPasswordResetSecondFactor'>,
  kind: Schemas['FlowKind']
): Promise<Schemas['FlowAttempt']> {
  const { world } = ctx
  const attempt = loadAttempt(ctx, (ctx.params as { attemptId: string }).attemptId, kind)
  requireStep(attempt, 'needs_second_factor')
  const proof = ctx.body as Schemas['SecondFactorRequest']
  if (proof.method !== 'totp' && proof.method !== 'backup_code') {
    throw new SandboxError('flow.invalid_step')
  }
  if (!attempt.secondFactors.includes(proof.method)) {
    throw new SandboxError('flow.invalid_step')
  }
  const user = userOf(world, attempt)
  await checkSecondFactor(world, user, { method: proof.method, code: text(proof.code, 'code') })
  attempt.proven.push(proof.method === 'totp' ? 'totp' : 'backup_code', 'mfa')
  attempt.status = 'complete'
  const remaining = user.backupCodes.length
  return finish(
    world,
    attempt,
    ctx.client,
    proof.method === 'backup_code' ? { backupCodesRemaining: remaining } : {}
  )
}

function startEnrolment(
  ctx: Context<OperationId>,
  kind: Schemas['FlowKind']
): Schemas['TotpEnrolment'] {
  const { world } = ctx
  const attempt = loadAttempt(ctx, (ctx.params as { attemptId: string }).attemptId, kind)
  requireStep(attempt, 'needs_factor_enrolment')
  const user = userOf(world, attempt)
  const secret = newTotpSecret()
  attempt.enrolmentSecret = secret
  return { secret, uri: otpauth(world, user, secret) }
}

async function confirmEnrolment(
  ctx: Context<OperationId>,
  kind: Schemas['FlowKind']
): Promise<Schemas['FlowAttempt']> {
  const { world } = ctx
  const attempt = loadAttempt(ctx, (ctx.params as { attemptId: string }).attemptId, kind)
  requireStep(attempt, 'needs_factor_enrolment')
  const user = userOf(world, attempt)
  const code = text((ctx.body as { code?: unknown }).code, 'code')
  if (attempt.enrolmentSecret === null) {
    throw new SandboxError('mfa.enrolment_expired')
  }
  world.assertNotLocked(`mfa:${user.id}`)
  const step = await matchTotp(attempt.enrolmentSecret, code.replace(/\s/g, ''), world.now())
  if (step === null) {
    world.countFailure(`mfa:${user.id}`)
    throw new SandboxError('mfa.invalid_code')
  }
  world.clearFailures(`mfa:${user.id}`)
  user.totp = { secret: attempt.enrolmentSecret, confirmedAt: iso(world.now()) }
  world.usedTotpSteps.set(user.id, step)
  const codes = newBackupCodes(world, user)
  attempt.proven.push('totp', 'mfa')
  attempt.status = 'complete'
  return finish(world, attempt, ctx.client, { backupCodes: codes })
}

function otpauth(world: World, user: SandboxUser, secret: string): string {
  const issuer = encodeURIComponent(world.settings.appName)
  return `otpauth://totp/${issuer}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${issuer}`
}

// -- Resend -------------------------------------------------------------------------------------

function resend(ctx: Context<OperationId>, kind: Schemas['FlowKind']): Schemas['FlowAttempt'] {
  const { world } = ctx
  const attempt = loadAttempt(ctx, (ctx.params as { attemptId: string }).attemptId, kind)
  const known = userByEmail(world, attempt.identifier) !== undefined
  if (kind === 'password_reset') {
    requireStep(attempt, 'needs_new_password')
    sendCode(world, attempt, { to: attempt.identifier, known, purpose: 'reset' })
  } else if (kind === 'sign_up') {
    requireStep(attempt, 'needs_email_verification')
    sendCode(world, attempt, {
      to: attempt.identifier,
      known: !known,
      purpose: 'verify',
      notice: 'has-account',
    })
  } else if (attempt.status === 'needs_email_verification') {
    sendCode(world, attempt, { to: attempt.identifier, known: true, purpose: 'verify' })
  } else {
    requireStep(attempt, 'needs_first_factor')
    if (attempt.prepared === null) {
      throw new SandboxError('flow.invalid_step')
    }
    sendCode(world, attempt, {
      to: attempt.identifier,
      known,
      purpose: 'sign-in',
      ...(attempt.prepared === 'email_link' &&
        attempt.linkRedirectUrl && { link: attempt.linkRedirectUrl }),
    })
  }
  return attemptBody(world, attempt)
}

// -- OAuth --------------------------------------------------------------------------------------

function startProviderRound(
  ctx: Context<'startOAuthSignIn' | 'startIdentityLink'>,
  intent: 'sign_in' | 'link'
): { attempt: SandboxAttempt; authorizationUrl: string; binding: string } {
  const { world } = ctx
  const body = ctx.body as Schemas['OAuthStartRequest']
  const provider = body.provider as SandboxProvider
  if (!world.settings.oauth.includes(provider)) {
    throw new SandboxError('auth.method_disabled', { params: { method: provider } })
  }
  const redirectUrl = redirect(world, body.redirectUrl, 'redirectUrl')
  const binding = `sbx_ob_${world.secret(18)}`
  const linkUser = intent === 'link' ? authenticate(ctx).user : null
  if (linkUser?.identities.some((identity) => identity.provider === provider)) {
    throw new SandboxError('oauth.already_linked')
  }
  const attempt = startAttempt(world, 'sign_in', 'needs_first_factor', {
    identifier: '',
    strategies: [oauthStrategy(provider)],
  })
  attempt.oauth = {
    provider,
    redirectUrl,
    binding,
    intent,
    linkUserId: linkUser?.id ?? null,
    result: null,
  }
  const authorizationUrl = `${SANDBOX_ORIGIN}/oauth/${provider}/authorize?attempt=${attempt.id}`
  world.changed()
  return { attempt, authorizationUrl, binding }
}

function takeTicket(ctx: Context<'exchangeOAuthTicket' | 'exchangeIdentityLinkTicket'>): {
  attempt: SandboxAttempt
  provider: SandboxProvider
  profile: NonNullable<NonNullable<SandboxAttempt['oauth']>['result']>['profile']
} {
  const { world } = ctx
  const body = ctx.body as Schemas['OAuthExchangeRequest']
  const attempt = world.attempts.get(body.attemptId)
  const oauth = attempt?.oauth
  if (!attempt || !oauth || oauth.result === null || attempt.expiresAt <= world.now()) {
    throw new SandboxError('oauth.ticket_invalid')
  }
  // The binding is what keeps another browser's ticket from signing anyone in here.
  if (body.binding !== oauth.binding) {
    throw new SandboxError('oauth.different_browser')
  }
  const { result } = oauth
  if (result.used || result.ticket !== body.ticket || result.expiresAt <= world.now()) {
    throw new SandboxError('oauth.ticket_invalid')
  }
  result.used = true
  return { attempt, provider: oauth.provider, profile: result.profile }
}

// -- The table -----------------------------------------------------------------------------------

/** The handler of every operation of the client API. */
export const HANDLERS: Handlers = {
  getClientConfig: ({ world }) => ({
    app: { name: world.settings.appName, supportEmail: null },
    signIn: {
      methods: (['password', 'emailCode', 'emailLink', 'passkey'] as const).filter(
        (method) => world.settings.methods[method]
      ),
      oauth: [...world.settings.oauth],
    },
    signUp: { password: world.settings.signUpPassword },
    password: SANDBOX_PASSWORD_POLICY,
    mfa: { policy: world.settings.mfaPolicy, smsCode: false },
    phone: { enabled: false },
  }),
  getPasswordPolicy: () => SANDBOX_PASSWORD_POLICY,

  // Sign-in ----------------------------------------------------------------------------------
  startSignIn: ({ world, body }) => {
    const strategies = firstFactors(world)
    if (strategies.length === 0) {
      throw new SandboxError('auth.method_disabled')
    }
    // The step depends on the settings alone, never on whether the identifier has an account.
    const identifier = text(body.identifier, 'identifier')
    const attempt = startAttempt(
      world,
      'sign_in',
      strategies.length === 1 && strategies[0] === 'password'
        ? 'needs_password'
        : 'needs_first_factor',
      { identifier: normalizeEmail(identifier), strategies }
    )
    return attemptBody(world, attempt, { attemptSecret: attempt.secret })
  },
  submitSignInPassword: (ctx) => {
    const { world, params, body } = ctx
    requireMethod(world, 'password')
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_in')
    if (
      !(
        attempt.status === 'needs_password' ||
        (attempt.status === 'needs_first_factor' && attempt.strategies.includes('password'))
      )
    ) {
      throw new SandboxError('flow.invalid_step')
    }
    world.assertNotLocked(attempt.identifier)
    const user = userByEmail(world, attempt.identifier)
    // Unknown account, no password and a wrong password are one answer.
    if (!user || user.password === null || user.password !== body.password) {
      world.countFailure(attempt.identifier)
      throw new SandboxError('auth.invalid_credentials')
    }
    world.clearFailures(attempt.identifier)
    attempt.passwordProven = true
    afterFirstFactor(world, attempt, user, 'pwd')
    return advance(world, attempt, ctx.client)
  },
  prepareSignInFirstFactor: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_in')
    requireStep(attempt, 'needs_first_factor')
    const strategy = body.strategy
    if (strategy !== 'email_code' && strategy !== 'email_link') {
      throw new SandboxError('auth.method_disabled')
    }
    if (!attempt.strategies.includes(strategy)) {
      throw new SandboxError('auth.method_disabled')
    }
    world.assertNotLocked(attempt.identifier)
    const known = userByEmail(world, attempt.identifier) !== undefined
    const link =
      strategy === 'email_link' ? redirect(world, body.redirectUrl, 'redirectUrl') : undefined
    attempt.prepared = strategy
    attempt.linkVerified = false
    attempt.linkRedirectUrl = link ?? null
    sendCode(world, attempt, {
      to: attempt.identifier,
      known,
      purpose: 'sign-in',
      ...(link && { link }),
    })
    if (strategy === 'email_link') {
      attempt.linkBinding = `sbx_lb_${world.secret(18)}`
      return attemptBody(world, attempt, { linkBinding: attempt.linkBinding })
    }
    return attemptBody(world, attempt)
  },
  attemptSignInFirstFactor: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_in')
    requireStep(attempt, 'needs_first_factor')
    if (body.strategy === 'sms_code') {
      throw new SandboxError('auth.method_disabled')
    }
    if (!attempt.strategies.includes(body.strategy)) {
      throw new SandboxError('auth.method_disabled')
    }
    const user = userByEmail(world, attempt.identifier)
    if (body.strategy === 'email_link') {
      // Nothing is counted while waiting: the client simply asks again.
      if (!attempt.linkVerified || !user) {
        return attemptBody(world, attempt)
      }
      attempt.linkVerified = false
      user.emailVerifiedAt ??= iso(world.now())
      afterFirstFactor(world, attempt, user, 'email', { verifyEmail: false })
      return advance(world, attempt, ctx.client)
    }
    if (attempt.prepared !== 'email_code' && attempt.prepared !== 'email_link') {
      // Before any code was asked for, a code answers like an expired one.
      throw new SandboxError('verification.expired')
    }
    checkCode(world, attempt, text(body.code, 'code'), attempt.identifier)
    if (!user) {
      throw new SandboxError('auth.invalid_credentials')
    }
    user.emailVerifiedAt ??= iso(world.now())
    afterFirstFactor(world, attempt, user, 'email', { verifyEmail: false })
    return advance(world, attempt, ctx.client)
  },
  verifySignInLink: ({ world, body }) => {
    const attempt = world.attempts.get(body.attemptId)
    if (attempt?.kind !== 'sign_in' || attempt.expiresAt <= world.now()) {
      throw new SandboxError('verification.expired')
    }
    // A link opened in a browser that did not ask for it proves nothing, and is not used up.
    if (!body.binding || body.binding !== attempt.linkBinding) {
      throw new SandboxError('verification.different_browser')
    }
    const pending = attempt.verification
    const mail = pending && world.inbox.find((message) => message.id === pending.emailId)
    if (
      !pending ||
      pending.decoy ||
      pending.linkToken === null ||
      pending.linkToken !== body.token ||
      pending.expiresAt <= world.now() ||
      mail?.expired
    ) {
      throw new SandboxError('verification.expired')
    }
    attempt.linkVerified = true
    attempt.verification = null
    world.changed()
    return { status: 'verified' }
  },
  verifySignInEmail: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_in')
    requireStep(attempt, 'needs_email_verification')
    const user = userOf(world, attempt)
    checkCode(world, attempt, text(body.code, 'code'), user.email)
    user.emailVerifiedAt = iso(world.now())
    afterEmailOrFactor(world, attempt, user)
    return advance(world, attempt, ctx.client)
  },
  resendSignInCode: (ctx) => resend(ctx, 'sign_in'),
  submitSignInSecondFactor: (ctx) => submitSecondFactorStep(ctx, 'sign_in'),
  startSignInTotpEnrolment: (ctx) => startEnrolment(ctx, 'sign_in'),
  confirmSignInTotpEnrolment: (ctx) => confirmEnrolment(ctx, 'sign_in'),
  prepareSignInSecondFactor: () => unsupported('prepareSignInSecondFactor'),
  getSignInSecondFactorPasskeyOptions: () => unsupported('getSignInSecondFactorPasskeyOptions'),
  submitSignInNewPassword: () => unsupported('submitSignInNewPassword'),
  startIdTokenSignIn: () => unsupported('startIdTokenSignIn'),
  submitSignInIdToken: () => unsupported('submitSignInIdToken'),

  // Passkeys -----------------------------------------------------------------------------------
  startPasskeySignIn: ({ world }) => {
    requireMethod(world, 'passkey')
    const attempt = startAttempt(world, 'sign_in', 'needs_first_factor', {
      identifier: '',
      strategies: ['passkey'],
    })
    return {
      attempt: attemptBody(world, attempt, { attemptSecret: attempt.secret }),
      options: {
        challenge: world.secret(32),
        timeout: 60_000,
        rpId: 'sandbox.tula.invalid',
        userVerification: 'required',
      },
    }
  },
  submitSignInPasskey: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_in')
    requireStep(attempt, 'needs_first_factor')
    requireMethod(world, 'passkey')
    const credentialId = asObject(body.credential).id
    const holder = [...world.users.values()].find((user) =>
      user.passkeys.some((passkey) => passkey.credentialId === credentialId)
    )
    // The sandbox does not check the signature; it says so in the authenticator's sheet.
    if (!holder) {
      throw new SandboxError('auth.invalid_credentials')
    }
    const passkey = holder.passkeys.find((one) => one.credentialId === credentialId)
    if (passkey) {
      passkey.lastUsedAt = iso(world.now())
    }
    attempt.proven.push('passkey', 'mfa')
    afterFirstFactor(world, attempt, holder, 'passkey', { verifyEmail: false })
    return advance(world, attempt, ctx.client)
  },
  startPasskeyRegistration: (ctx) => {
    const { world } = ctx
    const { user } = authenticate(ctx)
    requireMethod(world, 'passkey')
    return {
      rp: { id: 'sandbox.tula.invalid', name: world.settings.appName },
      user: {
        id: btoa(user.id).replace(/=+$/, ''),
        name: user.email,
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      },
      challenge: world.secret(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      excludeCredentials: user.passkeys.map((passkey) => ({
        type: 'public-key' as const,
        id: passkey.credentialId,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
    }
  },
  finishPasskeyRegistration: (ctx) => {
    const { world, body } = ctx
    const { user } = authenticate(ctx)
    const credentialId = asObject(body.credential).id
    if (typeof credentialId !== 'string' || credentialId === '') {
      throw new SandboxError('passkey.registration_failed')
    }
    if (user.passkeys.some((passkey) => passkey.credentialId === credentialId)) {
      throw new SandboxError('passkey.already_registered')
    }
    const passkey = {
      id: world.id('pky'),
      credentialId,
      name: body.name?.trim() || 'Sandbox passkey',
      createdAt: iso(world.now()),
      lastUsedAt: null,
    }
    user.passkeys.push(passkey)
    world.changed()
    return {
      id: passkey.id,
      name: passkey.name,
      synced: false,
      createdAt: passkey.createdAt,
      lastUsedAt: null,
    }
  },
  listMyPasskeys: (ctx) => ({
    passkeys: authenticate(ctx).user.passkeys.map((passkey) => ({
      id: passkey.id,
      name: passkey.name,
      synced: false,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    })),
  }),
  renamePasskey: (ctx) => {
    const { user } = authenticate(ctx)
    const passkey = user.passkeys.find((one) => one.id === ctx.params.passkeyId)
    if (!passkey) {
      throw new SandboxError('resource.not_found')
    }
    passkey.name = text(ctx.body.name, 'name').trim()
    return {
      id: passkey.id,
      name: passkey.name,
      synced: false,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    }
  },
  removePasskey: (ctx) => {
    const { user } = authenticate(ctx)
    const at = user.passkeys.findIndex((one) => one.id === ctx.params.passkeyId)
    if (at === -1) {
      throw new SandboxError('resource.not_found')
    }
    // The last way in cannot be removed.
    if (user.passkeys.length === 1 && user.password === null && user.identities.length === 0) {
      throw new SandboxError('passkey.last_sign_in_method')
    }
    user.passkeys.splice(at, 1)
    ctx.world.changed()
    return undefined
  },

  // OAuth -------------------------------------------------------------------------------------
  startOAuthSignIn: (ctx) => {
    const { attempt, authorizationUrl, binding } = startProviderRound(ctx, 'sign_in')
    return {
      attempt: attemptBody(ctx.world, attempt, { attemptSecret: attempt.secret }),
      authorizationUrl,
      binding,
    }
  },
  exchangeOAuthTicket: (ctx) => {
    const { world } = ctx
    const { attempt, provider, profile } = takeTicket(ctx)
    const address = normalizeEmail(profile.email)
    let user = [...world.users.values()].find((one) =>
      one.identities.some(
        (identity) => identity.provider === provider && identity.subject === profile.subject
      )
    )
    if (!user) {
      const holder = userByEmail(world, address)
      if (holder) {
        // Linked automatically only because the provider vouches for the address and ours is verified.
        if (holder.emailVerifiedAt === null) {
          throw new SandboxError('oauth.account_exists')
        }
        user = holder
      } else {
        const [first, ...rest] = profile.name.split(' ')
        user = {
          id: world.id('usr'),
          email: address,
          password: null,
          firstName: first ?? null,
          lastName: rest.join(' ') || null,
          emailVerifiedAt: iso(world.now()),
          createdAt: iso(world.now()),
          lastSignInAt: null,
          totp: null,
          backupCodes: [],
          passkeys: [],
          identities: [],
        }
        world.users.set(user.id, user)
      }
      user.identities.push({
        id: world.id('idn'),
        provider,
        subject: profile.subject,
        createdAt: iso(world.now()),
      })
    }
    // The secret is rotated at the exchange, as the real service does.
    attempt.secret = `sbx_as_${world.secret(24)}`
    afterFirstFactor(world, attempt, user, 'oauth', { verifyEmail: false })
    return advance(world, attempt, ctx.client, { attemptSecret: attempt.secret })
  },
  startIdentityLink: (ctx) => {
    const { attempt, authorizationUrl, binding } = startProviderRound(ctx, 'link')
    return {
      attemptId: attempt.id,
      expiresAt: iso(attempt.expiresAt),
      authorizationUrl,
      binding,
    }
  },
  exchangeIdentityLinkTicket: (ctx) => {
    const { world } = ctx
    const { user } = authenticate(ctx)
    const { attempt, provider, profile } = takeTicket(ctx)
    if (attempt.oauth?.linkUserId !== user.id) {
      throw new SandboxError('oauth.ticket_invalid')
    }
    const holder = [...world.users.values()].find((one) =>
      one.identities.some(
        (identity) => identity.provider === provider && identity.subject === profile.subject
      )
    )
    if (holder) {
      throw new SandboxError('oauth.identity_in_use')
    }
    const identity = {
      id: world.id('idn'),
      provider,
      subject: profile.subject,
      createdAt: iso(world.now()),
    }
    user.identities.push(identity)
    world.changed()
    return { id: identity.id, provider, createdAt: identity.createdAt }
  },
  listMyIdentities: (ctx) => ({
    data: authenticate(ctx).user.identities.map((identity) => ({
      id: identity.id,
      provider: identity.provider,
      createdAt: identity.createdAt,
    })),
  }),
  deleteMyIdentity: (ctx) => {
    const { user } = authenticate(ctx)
    const at = user.identities.findIndex((identity) => identity.id === ctx.params.identityId)
    if (at === -1) {
      throw new SandboxError('resource.not_found')
    }
    if (user.identities.length === 1 && user.password === null && user.passkeys.length === 0) {
      throw new SandboxError('identity.last_sign_in_method')
    }
    user.identities.splice(at, 1)
    ctx.world.changed()
    return undefined
  },

  // Sign-up ------------------------------------------------------------------------------------
  startSignUp: ({ world, body }) => {
    const address = email(body.email)
    const optional = world.settings.signUpPassword === 'optional'
    const password =
      typeof body.password === 'string' && body.password !== '' ? body.password : null
    if (password === null && !optional) {
      throw new SandboxError('validation.failed', {
        fields: [{ field: 'password', code: 'validation.failed', message: 'Enter a password.' }],
      })
    }
    if (password !== null) {
      assertPolicy(password, { email: address, firstName: body.firstName, lastName: body.lastName })
    }
    const exists = userByEmail(world, address) !== undefined
    const attempt = startAttempt(world, 'sign_up', 'needs_email_verification', {
      identifier: normalizeEmail(address),
      signUp: {
        password,
        firstName: body.firstName?.trim() || null,
        lastName: body.lastName?.trim() || null,
      },
    })
    // An address that has an account gets the same step, and a notice instead of a code.
    sendCode(world, attempt, {
      to: attempt.identifier,
      known: !exists,
      purpose: 'verify',
      notice: 'has-account',
    })
    return attemptBody(world, attempt, { attemptSecret: attempt.secret })
  },
  verifySignUpEmail: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'sign_up')
    requireStep(attempt, 'needs_email_verification')
    checkCode(world, attempt, text(body.code, 'code'), attempt.identifier)
    const details = attempt.signUp
    if (details === null || userByEmail(world, attempt.identifier)) {
      throw new SandboxError('verification.expired')
    }
    const user: SandboxUser = {
      id: world.id('usr'),
      email: attempt.identifier,
      password: details.password,
      firstName: details.firstName,
      lastName: details.lastName,
      emailVerifiedAt: iso(world.now()),
      createdAt: iso(world.now()),
      lastSignInAt: null,
      totp: null,
      backupCodes: [],
      passkeys: [],
      identities: [],
    }
    world.users.set(user.id, user)
    attempt.userId = user.id
    attempt.proven.push(details.password === null ? 'email' : 'pwd')
    attempt.status = world.settings.mfaPolicy === 'required' ? 'needs_factor_enrolment' : 'complete'
    return advance(world, attempt, ctx.client)
  },
  resendSignUpCode: (ctx) => resend(ctx, 'sign_up'),
  startSignUpTotpEnrolment: (ctx) => startEnrolment(ctx, 'sign_up'),
  confirmSignUpTotpEnrolment: (ctx) => confirmEnrolment(ctx, 'sign_up'),

  // Password reset -----------------------------------------------------------------------------
  startPasswordReset: ({ world, body }) => {
    const address = email(body.email)
    const user = userByEmail(world, address)
    const attempt = startAttempt(world, 'password_reset', 'needs_new_password', {
      identifier: normalizeEmail(address),
      userId: user?.id ?? null,
    })
    sendCode(world, attempt, {
      to: attempt.identifier,
      known: user !== undefined,
      purpose: 'reset',
    })
    return attemptBody(world, attempt, { attemptSecret: attempt.secret })
  },
  submitPasswordReset: (ctx) => {
    const { world, params, body } = ctx
    const attempt = loadAttempt(ctx, params.attemptId, 'password_reset')
    requireStep(attempt, 'needs_new_password')
    checkCode(world, attempt, text(body.code, 'code'), attempt.identifier)
    const user = userOf(world, attempt)
    const password = text(body.password, 'password')
    assertPolicy(password, user)
    user.password = password
    user.emailVerifiedAt ??= iso(world.now())
    // Every session of the account ends with its password.
    for (const [id, session] of world.sessions) {
      if (session.userId === user.id) {
        world.sessions.delete(id)
      }
    }
    attempt.proven.push('email')
    const { options, enrol } = secondFactorsFor(world, user)
    // An inbox alone never bypasses a second factor.
    if (options.length > 0) {
      attempt.status = 'needs_second_factor'
      attempt.secondFactors = options
    } else {
      attempt.status = enrol ? 'needs_factor_enrolment' : 'complete'
    }
    return advance(world, attempt, ctx.client)
  },
  resendPasswordResetCode: (ctx) => resend(ctx, 'password_reset'),
  submitPasswordResetSecondFactor: (ctx) => submitSecondFactorStep(ctx, 'password_reset'),
  startPasswordResetTotpEnrolment: (ctx) => startEnrolment(ctx, 'password_reset'),
  confirmPasswordResetTotpEnrolment: (ctx) => confirmEnrolment(ctx, 'password_reset'),
  preparePasswordResetSecondFactor: () => unsupported('preparePasswordResetSecondFactor'),
  getPasswordResetSecondFactorPasskeyOptions: () =>
    unsupported('getPasswordResetSecondFactorPasskeyOptions'),

  // Sessions -----------------------------------------------------------------------------------
  refreshSession: ({ world, body, client }) => {
    // A web client's token is in a cookie the sandbox keeps; a native client sends it.
    const token = body.refreshToken ?? world.cookie.refreshToken
    if (!token) {
      throw new SandboxError('session.invalid_token')
    }
    const reused = world.retiredTokens.get(token)
    if (reused !== undefined) {
      // A token that was already rotated ends the whole session.
      world.sessions.delete(reused)
      world.cookie.refreshToken = null
      world.changed()
      throw new SandboxError('session.reuse_detected')
    }
    const session = [...world.sessions.values()].find((one) => one.refreshToken === token)
    if (!session) {
      throw new SandboxError('session.invalid_token')
    }
    if (session.expiresAt <= world.now()) {
      world.sessions.delete(session.id)
      throw new SandboxError('session.expired')
    }
    world.retiredTokens.set(token, session.id)
    session.refreshToken = `sbx_rt_${world.secret(24)}`
    session.lastActiveAt = world.now()
    return tokensFor(world, session, client)
  },
  signOut: ({ world, body }) => {
    const token = body.refreshToken ?? world.cookie.refreshToken
    const session = [...world.sessions.values()].find((one) => one.refreshToken === token)
    if (session) {
      world.sessions.delete(session.id)
    }
    world.cookie.refreshToken = null
    world.changed()
    return undefined
  },
  listSessions: (ctx) => {
    const { user, session: current } = authenticate(ctx)
    return {
      data: [...ctx.world.sessions.values()]
        .filter((session) => session.userId === user.id)
        .map((session) => ({
          id: session.id,
          client: session.client,
          userAgent: 'Sandbox browser',
          ipAddress: null,
          createdAt: iso(session.createdAt),
          lastActiveAt: iso(session.lastActiveAt),
          expiresAt: iso(session.expiresAt),
          current: session.id === current.id,
          deviceBound: false,
        })),
    }
  },
  revokeSession: (ctx) => {
    const { user, session: current } = authenticate(ctx)
    const target = ctx.world.sessions.get(ctx.params.sessionId)
    if (!target || target.userId !== user.id) {
      throw new SandboxError('resource.not_found')
    }
    ctx.world.sessions.delete(target.id)
    if (target.id === current.id) {
      ctx.world.cookie.refreshToken = null
    }
    ctx.world.changed()
    return undefined
  },
  revokeOtherSessions: (ctx) => {
    const { user, session: current } = authenticate(ctx)
    let revoked = 0
    for (const [id, session] of ctx.world.sessions) {
      if (session.userId === user.id && id !== current.id) {
        ctx.world.sessions.delete(id)
        revoked += 1
      }
    }
    ctx.world.changed()
    return { revoked }
  },
  stepUpSession: () => unsupported('stepUpSession'),
  sendStepUpEmailCode: () => unsupported('sendStepUpEmailCode'),
  sendStepUpSmsCode: () => unsupported('sendStepUpSmsCode'),
  getStepUpPasskeyOptions: () => unsupported('getStepUpPasskeyOptions'),

  // The signed-in user ------------------------------------------------------------------------
  getMe: (ctx) => currentUser(authenticate(ctx).user),
  changeMyPassword: (ctx) => {
    const { user, session } = authenticate(ctx)
    const { world } = ctx
    world.assertNotLocked(`pw:${user.id}`)
    if (user.password === null || user.password !== ctx.body.currentPassword) {
      world.countFailure(`pw:${user.id}`)
      throw new SandboxError('auth.invalid_credentials')
    }
    world.clearFailures(`pw:${user.id}`)
    const next = text(ctx.body.newPassword, 'newPassword')
    assertPolicy(next, user)
    user.password = next
    for (const [id, other] of world.sessions) {
      if (other.userId === user.id && id !== session.id) {
        world.sessions.delete(id)
      }
    }
    world.changed()
    return undefined
  },
  requestEmailAddressCode: () => {
    // Every sandbox account has an address; this route is for an account that has none.
    throw new SandboxError('email.already_set')
  },
  verifyEmailAddress: () => {
    throw new SandboxError('email.already_set')
  },
  requestPhoneCode: () => unsupported('requestPhoneCode'),
  verifyPhoneNumber: () => unsupported('verifyPhoneNumber'),
  removePhoneNumber: () => unsupported('removePhoneNumber'),

  // Organizations (ADR 0065) are switched off in the sandbox -----------------------------------
  listMyOrganizations: () => unsupported('listMyOrganizations'),
  createMyOrganization: () => unsupported('createMyOrganization'),
  setActiveOrganization: () => unsupported('setActiveOrganization'),
  listMyOrganizationSuggestions: () => unsupported('listMyOrganizationSuggestions'),
  joinOrganizationSuggestion: () => unsupported('joinOrganizationSuggestion'),
  listMyOrganizationDomains: () => unsupported('listMyOrganizationDomains'),
  startMyOrganizationDomain: () => unsupported('startMyOrganizationDomain'),
  verifyMyOrganizationDomain: () => unsupported('verifyMyOrganizationDomain'),
  updateMyOrganizationDomain: () => unsupported('updateMyOrganizationDomain'),
  removeMyOrganizationDomain: () => unsupported('removeMyOrganizationDomain'),

  // Two-step verification ---------------------------------------------------------------------
  getMyFactors: (ctx) => {
    const { user } = authenticate(ctx)
    return {
      totp: {
        enabled: user.totp?.confirmedAt != null,
        confirmedAt: user.totp?.confirmedAt ?? null,
      },
      backupCodes: { remaining: user.totp?.confirmedAt ? user.backupCodes.length : 0 },
      sms: { enabled: false, enabledAt: null, inUse: false, available: false },
    }
  },
  startTotpEnrolment: (ctx) => {
    const { user } = authenticate(ctx)
    if (ctx.world.settings.mfaPolicy === 'off') {
      throw new SandboxError('mfa.not_available')
    }
    if (user.totp?.confirmedAt) {
      throw new SandboxError('mfa.already_enabled')
    }
    const secret = newTotpSecret()
    user.totp = { secret, confirmedAt: null }
    return { secret, uri: otpauth(ctx.world, user, secret) }
  },
  confirmTotpEnrolment: async (ctx) => {
    const { user } = authenticate(ctx)
    const { world } = ctx
    if (!user.totp || user.totp.confirmedAt) {
      throw new SandboxError('mfa.enrolment_expired')
    }
    world.assertNotLocked(`mfa:${user.id}`)
    const step = await matchTotp(
      user.totp.secret,
      text(ctx.body.code, 'code').replace(/\s/g, ''),
      world.now()
    )
    if (step === null) {
      world.countFailure(`mfa:${user.id}`)
      throw new SandboxError('mfa.invalid_code')
    }
    world.clearFailures(`mfa:${user.id}`)
    user.totp.confirmedAt = iso(world.now())
    world.usedTotpSteps.set(user.id, step)
    world.changed()
    return { codes: newBackupCodes(world, user) }
  },
  disableTotp: (ctx) => {
    const { user } = authenticate(ctx)
    if (!user.totp?.confirmedAt) {
      throw new SandboxError('mfa.not_enabled')
    }
    if (ctx.world.settings.mfaPolicy === 'required') {
      throw new SandboxError('mfa.required_by_policy')
    }
    user.totp = null
    user.backupCodes = []
    ctx.world.changed()
    return undefined
  },
  regenerateBackupCodes: (ctx) => {
    const { user } = authenticate(ctx)
    if (!user.totp?.confirmedAt) {
      throw new SandboxError('mfa.not_enabled')
    }
    return { codes: newBackupCodes(ctx.world, user) }
  },
  startSmsFactorEnrolment: () => unsupported('startSmsFactorEnrolment'),
  confirmSmsFactorEnrolment: () => unsupported('confirmSmsFactorEnrolment'),
  disableSmsFactor: () => unsupported('disableSmsFactor'),
}
