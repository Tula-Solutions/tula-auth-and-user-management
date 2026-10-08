import {
  createAdminClient,
  ifMatch,
  isTulaAdminError,
  type TulaWebhookEvent,
  verifyWebhook,
} from '@tula/admin'

// The admin API calls shown in docs/methods/*.md and docs/webhooks.md, through `@tula/admin` so that they are
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
  // Delivery is at least once: the same event id can arrive again.
  if (await alreadyHandled(event.id)) {
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
  // Answer quickly, with a 2xx and a small body. Anything else counts as a failed delivery.
  return new Response(null, { status: 204 })
}
// #endregion
