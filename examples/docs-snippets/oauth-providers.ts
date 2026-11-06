import { readFileSync } from 'node:fs'
import { createAdminClient } from '@tula-tech/admin'

// The OAuth provider calls shown in docs/providers/*.md, through `@tula-tech/admin`. Copied by
// region (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })

/** Store the apple credentials. */
export async function setApple() {
  // #region apple
  const key = readFileSync('AuthKey_XXXXXXXXXX.p8', 'utf8')
  await admin.call('updateOAuthProvider', {
    params: { provider: 'apple' },
    body: {
      clientId: 'com.example.web',
      teamId: '<team id>',
      keyId: '<key id>',
      privateKey: key,
    },
  })
  // #endregion
}

/** Store the discord credentials. */
export async function setDiscord() {
  // #region discord
  await admin.call('updateOAuthProvider', {
    params: { provider: 'discord' },
    body: {
      clientId: '<client id>',
      clientSecret: '<client secret>',
    },
  })
  // #endregion
}

/** Store the facebook credentials. */
export async function setFacebook() {
  // #region facebook
  await admin.call('updateOAuthProvider', {
    params: { provider: 'facebook' },
    body: {
      clientId: '<app id>',
      clientSecret: '<app secret>',
    },
  })
  // #endregion
}

/** Store the github credentials. */
export async function setGithub() {
  // #region github
  await admin.call('updateOAuthProvider', {
    params: { provider: 'github' },
    body: {
      clientId: '<client id>',
      clientSecret: '<client secret>',
    },
  })
  // #endregion
}

/** Store the google credentials. */
export async function setGoogle() {
  // #region google
  await admin.call('updateOAuthProvider', {
    params: { provider: 'google' },
    body: {
      clientId: '<client id>.apps.googleusercontent.com',
      clientSecret: '<client secret>',
    },
  })
  // #endregion
}

/** Store the google-additional-client-ids credentials. */
export async function setGoogleAdditionalClientIds() {
  // #region google-additional-client-ids
  await admin.call('updateOAuthProvider', {
    params: { provider: 'google' },
    body: {
      clientId: '<web client id>.apps.googleusercontent.com',
      additionalClientIds: [
        '<android client id>.apps.googleusercontent.com',
        '<ios client id>.apps.googleusercontent.com',
      ],
    },
  })
  // #endregion
}

/** Store the linkedin credentials. */
export async function setLinkedin() {
  // #region linkedin
  await admin.call('updateOAuthProvider', {
    params: { provider: 'linkedin' },
    body: {
      clientId: '<client id>',
      clientSecret: '<client secret>',
    },
  })
  // #endregion
}

/** Store the microsoft credentials. */
export async function setMicrosoft() {
  // #region microsoft
  await admin.call('updateOAuthProvider', {
    params: { provider: 'microsoft' },
    body: {
      clientId: '<application (client) id>',
      clientSecret: '<secret value>',
      tenant: 'organizations',
    },
  })
  // #endregion
}

/** Store the x credentials. */
export async function setX() {
  // #region x
  await admin.call('updateOAuthProvider', {
    params: { provider: 'x' },
    body: {
      clientId: '<client id>',
      clientSecret: '<client secret>',
    },
  })
  // #endregion
}
