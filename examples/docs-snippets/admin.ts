import {
  createAdminClient,
  ifMatch,
  isTulaAdminError,
  type TulaHookAnswer,
  type TulaHookClaimsAnswer,
  type TulaHookQuestion,
  type TulaWebhookEvent,
  verifyHook,
  verifyWebhook,
} from '@tula/admin'

// The admin API calls shown in docs/methods/*.md, docs/webhooks.md and docs/hooks.md, through `@tula/admin` so that they are
// typed against the OpenAPI contract. Copied by region (`bun run docs:generate`) and compiled
// by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

// #region client
// Server-side only: the secret key can do anything in its environment.
const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })
// #endregion

/** Replace the settings document with one change, under the revision that was read. */
export async function switchOnEmailSignIn() {
  // #region settings-email
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      signIn: {
        methods: {
          ...data.settings.signIn?.methods,
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: true },
        },
      },
      urls: {
        ...data.settings.urls,
        allowedRedirectUrls: ['https://app.example.com/auth/link'],
      },
    },
  })
  // #endregion
}

/** Let a sign-up leave the password out (needs the emailed code). */
export async function passwordlessSignUp() {
  // #region settings-sign-up
  const { data } = await admin.call('getEnvironmentSettings')
  try {
    await admin.call('replaceEnvironmentSettings', {
      headers: { 'If-Match': ifMatch(data.revision) },
      body: {
        ...data.settings,
        signIn: {
          methods: {
            ...data.settings.signIn?.methods,
            password: { enabled: true },
            emailCode: { enabled: true },
          },
        },
        signUp: { password: 'optional' },
      },
    })
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'precondition.failed') {
      // Someone else changed the settings since they were read: read them again.
    }
    throw error
  }
  // #endregion
}

/** Passkeys need the method, the relying party and the origins, in one document. */
export async function switchOnPasskeys() {
  // #region settings-passkeys
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      signIn: {
        methods: {
          ...data.settings.signIn?.methods,
          password: { enabled: true },
          passkey: { enabled: true },
        },
      },
      passkeys: { rpId: 'example.com' },
      urls: { ...data.settings.urls, allowedOrigins: ['https://app.example.com'] },
    },
  })
  // #endregion
}

/** Who must use two-step verification, and the reset for a user who lost theirs. */
export async function twoStepSettings(userId: string) {
  // #region settings-mfa
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: { ...data.settings, mfa: { policy: 'required' } },
  })
  // #endregion
  // #region reset-factors
  // Removes the user's authenticator, backup codes and passkeys, and signs them out everywhere.
  await admin.call('resetUserFactors', { params: { userId } })
  // #endregion
}

/** Session profiles and the concurrent-session rule. */
export async function sessionSettings(userId: string) {
  // #region settings-sessions
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      sessions: {
        ...data.settings.sessions,
        profiles: {
          ...data.settings.sessions?.profiles,
          web: { idleTimeout: '1d', absoluteTimeout: '14d' },
          'back-office': {
            type: 'hybrid',
            idleTimeout: '15m',
            absoluteTimeout: '8h',
            stepUpAfter: '5m',
            clientSelectable: true,
          },
        },
        maxPerUser: 5,
        onLimit: 'end_oldest',
      },
    },
  })
  // #endregion
  // #region revoke-sessions
  await admin.call('revokeUserSessions', { params: { userId } })
  // #endregion
}

/** A JWT template: custom claims for the sessions of a profile (ADR 0036). */
export async function jwtTemplateSettings() {
  // #region settings-jwt-template
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      sessions: {
        ...data.settings.sessions,
        jwtTemplates: {
          ...data.settings.sessions?.jwtTemplates,
          app: {
            claims: {
              email: { from: 'user.email' },
              email_verified: { from: 'user.email_verified' },
              plan: { value: 'team' },
            },
          },
        },
        profiles: {
          ...data.settings.sessions?.profiles,
          web: { ...data.settings.sessions?.profiles?.web, jwtTemplate: 'app' },
        },
      },
    },
  })
  // #endregion
}

/** Text messages: switched on, to the countries listed and no other (ADR 0037). */
export async function smsSettings() {
  // #region settings-sms
  const { data } = await admin.call('getEnvironmentSettings')
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: { ...data.settings, sms: { enabled: true, allowedCountries: ['US', 'DE'] } },
  })
  // #endregion
}

/** Text messages: the codes sent and never used, by destination prefix (ADR 0037). */
export async function smsUsage() {
  // #region sms-usage
  const { data } = await admin.call('getSmsUsage', { query: { days: 7 } })
  // A destination where most codes are never entered is being texted for money.
  const suspicious = data.prefixes.filter(({ sent, unused }) => sent >= 20 && unused / sent > 0.8)
  // #endregion
  return suspicious
}

/** Store a provider's credentials and read the redirect URI to register with it. */
export async function providers(clientSecret: string) {
  // #region providers
  await admin.call('updateOAuthProvider', {
    params: { provider: 'google' },
    body: {
      enabled: true,
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret, // from your secret manager; it is stored encrypted and never returned
    },
  })
  const { data } = await admin.call('listOAuthProviders')
  // data.data[n].callbackUrl is the redirect URI to register with the provider.
  // #endregion
  return data
}

/** Register a webhook endpoint and keep the secret its registration returns. */
export async function registerWebhook(storeSecret: (secret: string) => Promise<void>) {
  // #region webhook-register
  const { data: endpoint } = await admin.call('createWebhookEndpoint', {
    body: {
      url: 'https://api.example.com/webhooks/tula',
      eventTypes: ['user.created', 'user.deleted', 'session.reuse_detected'],
    },
  })
  // The only time the secret is returned: put it in your secret manager now.
  await storeSecret(endpoint.secret)
  // #endregion
  // #region webhook-manage
  // Stop deliveries (events from while it is off are not sent later), then remove it.
  await admin.call('updateWebhookEndpoint', {
    params: { id: endpoint.id },
    body: { enabled: false },
  })
  await admin.call('deleteWebhookEndpoint', { params: { id: endpoint.id } })
  // #endregion
}

/** Wherever you look at such things: yours. */
declare function show(...values: unknown[]): void

/** Read an endpoint's delivery log, test it, and send a failed delivery again. */
export async function inspectWebhook(endpointId: string) {
  // #region webhook-deliveries
  // What the server gave up on, newest first.
  const { data: failed } = await admin.call('listWebhookDeliveries', {
    params: { id: endpointId },
    query: { state: 'failed' },
  })
  for (const delivery of failed.data) {
    // Every request made for it: when, the status code (or why there was none), how long.
    const { data: detail } = await admin.call('getWebhookDelivery', {
      params: { id: endpointId, deliveryId: delivery.id },
    })
    show(
      delivery.eventType,
      detail.attempts.map((attempt) => attempt.statusCode)
    )
  }
  // #endregion
  // #region webhook-test
  // One signed example event, now. Your receiver sees `event.test === true`.
  const { data: test } = await admin.call('sendTestWebhook', {
    params: { id: endpointId },
    body: { eventType: 'user.created' },
  })
  if (test.outcome === 'failed') {
    // `statusCode` is what your endpoint answered; without an answer, `failureReason` says why.
    show(test.statusCode ?? test.failureReason)
  }
  // #endregion
  // #region webhook-redeliver
  // After fixing the receiver: send what it missed once more, with the same `webhook-id`.
  for (const delivery of failed.data) {
    try {
      await admin.call('redeliverWebhook', {
        params: { id: endpointId, deliveryId: delivery.id },
      })
    } catch (error) {
      // 409 `webhook.cannot_redeliver`: `params.reason` is `event_gone` (older than 30 days),
      // `endpoint_disabled` or `delivery_pending`.
      if (!isTulaAdminError(error) || error.code !== 'webhook.cannot_redeliver') {
        throw error
      }
    }
  }
  // #endregion
}

/** What handles an event once: yours. */
declare function alreadyHandled(eventId: string): Promise<boolean>
declare function provisionWorkspace(userId: string): Promise<void>
declare function alertSecurity(userId: string): Promise<void>
/** The endpoint's signing secret (`whsec_…`), from your secret manager. */
declare const webhookSecret: string

// #region webhook-verify
// The route your endpoint's address leads to, on any server that gives you a `Request`.
export async function receiveWebhook(request: Request): Promise<Response> {
  let event: TulaWebhookEvent
  try {
    // The body exactly as it arrived: the signature is over these bytes.
    event = await verifyWebhook(await request.text(), request.headers, webhookSecret)
  } catch (error) {
    // Not from Tula, changed on the way, or older than five minutes.
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  // A test event an administrator sent: an example, nothing in it happened.
  // And delivery is at least once: the same event id can arrive again.
  if (event.test || (await alreadyHandled(event.id))) {
    return new Response(null, { status: 204 })
  }
  switch (event.type) {
    case 'user.created':
      await provisionWorkspace(event.target.id)
      break
    case 'session.reuse_detected':
      await alertSecurity(event.data.userId)
      break
    default:
    // A type this code does not handle, or one a later server added: nothing to do.
  }
  // Answer quickly, with a 2xx and a small body. Anything else is a failed request, which
  // the server retries.
  return new Response(null, { status: 204 })
}
// #endregion

/** The secret a rotation replaced, kept in your secret manager until the overlap has ended. */
declare const previousWebhookSecret: string | undefined

/** Replace an endpoint's signing secret: the new one is returned once, like the first. */
export async function rotateWebhookSecret(
  endpointId: string,
  storeSecrets: (secrets: { current: string; previousUntil: string }) => Promise<void>
) {
  // #region webhook-rotate
  const { data: rotated } = await admin.call('rotateWebhookSecret', {
    params: { id: endpointId },
  })
  // The only time the new secret is returned. Keep the one you had beside it: until
  // `rotationOverlapEndsAt` (24 hours from now) every delivery is signed with both.
  await storeSecrets({ current: rotated.secret, previousUntil: rotated.rotationOverlapEndsAt })
  // #endregion
}

// #region webhook-verify-rotating
// While a secret is being replaced the receiver holds two: the new one and, until the
// overlap has ended, the one before it. A delivery is accepted if either signed it.
export async function verifyWhileRotating(request: Request): Promise<TulaWebhookEvent> {
  const secrets = previousWebhookSecret ? [webhookSecret, previousWebhookSecret] : webhookSecret
  return verifyWebhook(await request.text(), request.headers, secrets)
}
// #endregion

/** End an overlap early: for a previous secret that has leaked. */
export async function revokePreviousWebhookSecret(endpointId: string) {
  // #region webhook-revoke-previous
  // Once the receiver verifies with the new secret: stop the old one signing now, instead of
  // at the end of the 24 hours. Then take it out of the receiver.
  try {
    await admin.call('revokePreviousWebhookSecret', { params: { id: endpointId } })
  } catch (error) {
    // 409 `webhook.rotation_refused`, `params.reason: 'no_rotation_in_progress'`: the overlap
    // had already ended, and the old secret signs nothing.
    if (!isTulaAdminError(error) || error.code !== 'webhook.rotation_refused') {
      throw error
    }
  }
  // #endregion
}

/** Register the hook asked before a sign-up, and change it later. */
export async function registerHook(storeSecret: (secret: string) => Promise<void>) {
  // #region hook-register
  const { data: hook } = await admin.call('createHook', {
    body: {
      // `before_sign_up`, `before_session` or `before_token`: one hook per point.
      point: 'before_sign_up',
      url: 'https://api.example.com/tula/before-sign-up',
      // Optional: 2000 unless given, at least 100, never more than 5000.
      deadlineMs: 2000,
    },
  })
  // The only time the secret is returned: put it in your secret manager now.
  await storeSecret(hook.secret)
  // #endregion
  // #region hook-manage
  // What the operator sees of a hook that is failing: when, and a fixed word for why.
  const { data: current } = await admin.call('getHook', { params: { id: hook.id } })
  if (current.lastFailureReason === 'timeout') {
    // The endpoint did not answer inside `deadlineMs`.
  }
  // Each of these removes a check and is recorded with `weakened: true`.
  await admin.call('updateHook', { params: { id: hook.id }, body: { failureMode: 'allow' } })
  await admin.call('updateHook', { params: { id: hook.id }, body: { enabled: false } })
  await admin.call('deleteHook', { params: { id: hook.id } })
  // #endregion
}

/** The hook's signing secret (`whsec_…`), from your secret manager. */
declare const hookSecret: string
/** Your own rule. Keep it fast: the person signing up is waiting for the answer. */
declare function isDisposable(email: string): boolean

// #region hook-receive
// The route the hook's address leads to, on any server that gives you a `Request`.
export async function beforeSignUp(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    // The body exactly as it arrived: the signature is over these bytes.
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    // Not from Tula, changed on the way, older than five minutes, or not a question.
    // Never answer `allow` to a request that did not verify.
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_sign_up') {
    // Another point's question sent to this address: not one this route answers.
    return new Response(null, { status: 400 })
  }
  // `question.data` is the address being signed up, how (`password`, `passwordless`,
  // `oauth_google`, …), the kind of client and the IP address the request came from.
  const answer: TulaHookAnswer = isDisposable(question.data.email)
    ? // Your own code, for your app to turn into words: lower-case letters, digits, `_`.
      { decision: 'deny', code: 'disposable_email' }
    : { decision: 'allow' }
  // A 200 with exactly this body. Anything else is a failed call, not an answer.
  return Response.json(answer)
}
// #endregion

/** Your own rule about who may have a session now. Keep it fast. */
declare function isSuspended(userId: string): Promise<boolean>
/** Your own record of a user: what your application authorizes on. */
declare function planOf(userId: string): Promise<{ plan: string; seats: number }>

// #region hook-receive-session
// Asked when every factor of a sign-in is proven, just before its session is created.
export async function beforeSession(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_session') {
    return new Response(null, { status: 400 })
  }
  // `question.data` is the user's id, the kind of client, the session profile, what was
  // proven (`amr`), whether this sign-in created the account, and the IP address.
  const { userId, amr, profile } = question.data
  let answer: TulaHookAnswer = { decision: 'allow' }
  if (await isSuspended(userId)) {
    answer = { decision: 'deny', code: 'account_suspended' }
  } else if (profile === 'admin' && !amr.includes('mfa')) {
    // `amr` is a set: test membership, never position.
    answer = { decision: 'deny', code: 'two_step_needed' }
  }
  return Response.json(answer)
}
// #endregion

// #region hook-receive-token
// Asked when a session is created and when its user proves a factor again. Not at a
// refresh: what you answer is stored on the session and issued until one of those happens.
export async function beforeToken(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_token') {
    return new Response(null, { status: 400 })
  }
  const { plan, seats } = await planOf(question.data.userId)
  // Exactly `{ claims }`. Each value one string, number or boolean; no reserved name
  // (`sub`, `amr`, …); at most 1,024 bytes together with the profile's template claims.
  const answer: TulaHookClaimsAnswer = {
    claims: { plan, seats, elevated: question.data.amr.includes('mfa') },
  }
  return Response.json(answer)
}
// #endregion
