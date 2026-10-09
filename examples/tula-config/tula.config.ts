import { defineConfig, env } from '@tula/config'

// An example config: one file, two environments. Try it against the local stack:
//
//   export TULA_API_URL=http://localhost:3003
//   export TULA_SECRET_KEY=tula_sk_dev_…        # bun run api-key:create --environment <id>
//   bun run tula -- diff --config examples/tula-config/tula.config.ts --env dev
//
// The full guide is docs/config.md. The `#region` comments mark the parts docs/methods/*.md
// show (`bun run docs:generate` copies them).

/** Settings both environments share. A config is code: share with a spread, not a copy. */
const shared = {
  app: { name: 'Northline', supportEmail: 'help@northline.app' },
  // #region methods
  signIn: {
    methods: {
      password: { enabled: true },
      emailCode: { enabled: true },
      emailLink: { enabled: true },
    },
  },
  // #endregion
  notifications: {
    passwordChanged: true,
    newSignIn: true,
    mfaChanged: true,
    identityChanged: true,
  },
} as const

export default defineConfig({
  environments: {
    dev: {
      // `tula` refuses a production key for this entry, and a development key for `prod`.
      kind: 'development',
      settings: {
        ...shared,
        app: { ...shared.app, name: 'Northline (dev)' },
        // `password` is left out: the deployment's PASSWORD_POLICY stays in force.
        urls: {
          allowedOrigins: ['http://localhost:5173', 'http://localhost:3000'],
          allowedRedirectUrls: ['http://localhost:5173/auth/callback'],
        },
        mfa: { policy: 'optional' },
      },
      providers: {
        // The client id is not a secret. The secret is named, never written.
        github: { clientId: 'Iv1.0123456789abcdef', clientSecret: env('GITHUB_CLIENT_SECRET_DEV') },
      },
    },

    prod: {
      kind: 'production',
      settings: {
        ...shared,
        // #region password
        password: {
          preset: 'custom',
          minLength: 12,
          maxLength: 128,
          requireLowercase: false,
          requireUppercase: false,
          requireNumber: false,
          requireSpecial: false,
          minCharacterClasses: 0,
          specialChars: '!@#$%^&*()-_=+[]{};:,.?/\\|\'"`~<>',
          disallowUserInfo: true,
          disallowCommon: true,
          breachCheck: 'block',
          maxRepeatedChars: null,
          blockSequences: false,
          history: 5,
          expiryDays: null,
        },
        // #endregion
        // #region sign-up
        signUp: { password: 'required' },
        // #endregion
        // #region urls
        urls: {
          allowedOrigins: ['https://app.northline.app'],
          allowedRedirectUrls: ['https://app.northline.app/auth/callback'],
        },
        // #endregion
        audit: { retentionDays: 365 },
        // #region mfa
        mfa: { policy: 'required' },
        // #endregion
        // #region passkeys
        passkeys: { rpId: 'northline.app' },
        // #endregion
        // #region sessions
        sessions: {
          maxPerUser: 10,
          onLimit: 'end_oldest',
          profiles: {
            web: { idleTimeout: '7d', absoluteTimeout: '30d' },
            mobile: { idleTimeout: '30d', absoluteTimeout: '90d' },
          },
        },
        // #endregion
      },
      // #region providers
      providers: {
        google: {
          clientId: '1234567890-abc.apps.googleusercontent.com',
          clientSecret: env('GOOGLE_CLIENT_SECRET'),
        },
        github: { clientId: 'Iv1.fedcba9876543210', clientSecret: env('GITHUB_CLIENT_SECRET') },
        apple: {
          clientId: 'app.northline.web',
          teamId: 'A1B2C3D4E5',
          keyId: 'K1L2M3N4O5',
          // The whole .p8 file's contents, in a variable.
          privateKey: env('APPLE_PRIVATE_KEY'),
        },
        microsoft: {
          clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
          clientSecret: env('MICROSOFT_CLIENT_SECRET'),
          // Which accounts may sign in: 'common', 'organizations', 'consumers' or a tenant id.
          tenant: 'organizations',
        },
        discord: {
          clientId: '1198765432101234567',
          clientSecret: env('DISCORD_CLIENT_SECRET'),
        },
        linkedin: { clientId: '86abcdefgh1234', clientSecret: env('LINKEDIN_CLIENT_SECRET') },
        // X and Facebook are asked for no email address: an account made through either has
        // none, and is never joined to an account with one.
        x: { clientId: 'bEx4bXBsZUNsaWVudElk', clientSecret: env('X_CLIENT_SECRET') },
        // Facebook calls them the app id and the app secret.
        facebook: { clientId: '1234567890123456', clientSecret: env('FACEBOOK_APP_SECRET') },
      },
      // #endregion
      // #region webhooks
      // The endpoints this environment's events are posted to. An endpoint is its address;
      // there is no secret to write: the server makes it when `tula apply` registers the
      // endpoint (`--secrets-file <path>` keeps it). `enabled` is left out, so the switch
      // stays as the server has it. `dev` has no `webhooks` key: its endpoints are not
      // managed by this file.
      webhooks: [
        {
          url: 'https://api.northline.app/webhooks/tula',
          eventTypes: ['user.created', 'user.deleted'],
        },
      ],
      // #endregion
      // #region hooks
      // The questions this environment asks before it acts, by point: at most one hook per
      // point. There is no secret to write here either. What an entry leaves out is the
      // API's default: on, a deadline of two seconds, and `failureMode: 'deny'` (a call that
      // fails refuses what was asked about). `dev` has no `hooks` key: its hooks are not
      // managed by this file.
      hooks: {
        before_sign_up: { url: 'https://api.northline.app/hooks/tula/sign-up' },
        before_token: { url: 'https://api.northline.app/hooks/tula/claims', deadlineMs: 1000 },
      },
      // #endregion
    },
  },
})
