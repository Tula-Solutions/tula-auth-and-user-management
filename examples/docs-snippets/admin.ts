import { createAdminClient, ifMatch, isTulaAdminError } from '@tula/admin'

// The admin API calls shown in docs/methods/*.md, through `@tula/admin` so that they are
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
