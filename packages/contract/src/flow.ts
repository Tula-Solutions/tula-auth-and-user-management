import { z } from 'zod'
import { PasskeyAssertionCredentialSchema, PasskeyRequestOptionsSchema } from './passkey'

/** Second-factor methods a flow can ask for. */
export const SecondFactorMethodSchema = z
  .enum(['totp', 'passkey', 'backup_code', 'sms_code'])
  .meta({ ref: 'SecondFactorMethod' })

/**
 * Ways to prove who you are as the first step of a sign-in.
 *
 * Which ones a sign-in offers depends only on the environment's settings, never on the
 * identifier, so the list says nothing about any account.
 */
export const FirstFactorStrategySchema = z
  .enum([
    'password',
    'email_code',
    'email_link',
    'passkey',
    'oauth_google',
    'oauth_github',
    'oauth_apple',
    'oauth_microsoft',
    'oauth_discord',
    'oauth_linkedin',
    'oauth_x',
    'oauth_facebook',
  ])
  .meta({ ref: 'FirstFactorStrategy' })

/**
 * Second factors a user can enrol inside an attempt. `totp` is an authenticator app (RFC 6238).
 * A passkey is registered from a signed-in profile (`/v1/client/me/passkeys`), never here.
 */
export const FactorEnrolmentMethodSchema = z.enum(['totp']).meta({ ref: 'FactorEnrolmentMethod' })

/** How an email address can be verified. */
export const EmailVerificationStrategySchema = z
  .enum(['email_code', 'email_link'])
  .meta({ ref: 'EmailVerificationStrategy' })

/**
 * The next step of a sign-in or sign-up, decided by the server.
 *
 * Clients map each `status` to a native screen; they hold no flow logic of their own. That is
 * what lets a new auth method ship everywhere with only a server change (business plan §5.2).
 */
export const FlowStepSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('needs_identifier') }),
    z.object({ status: z.literal('needs_password') }),
    z.object({
      /**
       * A sign-in in an environment that offers more than one first factor: prove one of
       * `strategies`. An environment whose only method is the password answers `needs_password`
       * instead.
       */
      status: z.literal('needs_first_factor'),
      strategies: z.array(FirstFactorStrategySchema).min(1),
      /**
       * Present once an email was asked for (`first-factor/prepare`): which email strategy, and
       * the masked address it went to. The address is the identifier the attempt was started
       * with, so it says nothing about any account. A client that does not know the field can
       * ignore it: the step is otherwise unchanged.
       */
      prepared: z
        .object({ strategy: EmailVerificationStrategySchema, destination: z.string() })
        .optional(),
    }),
    z.object({
      status: z.literal('needs_email_verification'),
      /** Masked destination, e.g. `m***@northline.app`. */
      destination: z.string(),
      strategies: z.array(EmailVerificationStrategySchema).min(1),
    }),
    z.object({
      /**
       * A password reset: submit the emailed code together with the new password. They travel in
       * one request so that a verified attempt id never works as a credential on its own.
       */
      status: z.literal('needs_new_password'),
      /** Masked destination the code was sent to. */
      destination: z.string(),
      strategies: z.array(EmailVerificationStrategySchema).min(1),
    }),
    z.object({
      /**
       * The first factor was accepted and the user has a second one: prove one of `options`. No
       * session exists and no tokens are returned until then.
       */
      status: z.literal('needs_second_factor'),
      options: z.array(SecondFactorMethodSchema).min(1),
    }),
    z.object({
      /**
       * The environment requires a second factor (`mfa.policy: 'required'`) and the user has
       * none: enrol one of `methods` inside this attempt (`factor-enrolment/totp`, then
       * `…/confirm`). No session exists and no tokens are returned until it is confirmed.
       */
      status: z.literal('needs_factor_enrolment'),
      methods: z.array(FactorEnrolmentMethodSchema).min(1),
    }),
    z.object({
      status: z.literal('complete'),
      userId: z.string(),
      sessionId: z.string(),
    }),
  ])
  .meta({ ref: 'FlowStep' })

/** Status values of {@link FlowStepSchema}. */
export type FlowStatus = FlowStep['status']

/** Whether an attempt signs an existing user in, creates a new one, or resets a password. */
export const FlowKindSchema = z
  .enum(['sign_in', 'sign_up', 'password_reset'])
  .meta({ ref: 'FlowKind' })

/**
 * Tokens issued when a flow completes or a session is refreshed.
 *
 * `refreshToken` is only present for native/server clients. Browsers receive it as an httpOnly
 * cookie and never see it in JavaScript.
 *
 * `accessToken` and `accessTokenExpiresAt` are absent for a session of a `stateful` profile
 * (ADR 0028): the browser holds only an httpOnly session cookie, there is nothing for
 * JavaScript to keep, and requests are authenticated by sending that cookie
 * (`credentials: 'include'`). Every `hybrid` session carries both.
 */
export const SessionTokensSchema = z
  .object({
    sessionId: z.string(),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.iso.datetime().optional(),
    refreshToken: z.string().optional(),
  })
  .meta({ ref: 'SessionTokens' })

/** A sign-in or sign-up attempt and the step it is waiting on. */
export const FlowAttemptSchema = z
  .object({
    id: z.string(),
    kind: FlowKindSchema,
    expiresAt: z.iso.datetime(),
    step: FlowStepSchema,
    /**
     * The attempt's secret. Present **only** in the response that starts the attempt, never
     * again: keep it in memory and send it as `FLOW_ATTEMPT_HEADER` (`x-tula-attempt`) on every later call.
     */
    attemptSecret: z.string().optional(),
    /**
     * Present **only** in the response to `first-factor/prepare` with the `email_link` strategy.
     * A random value that ties the emailed link to the browser that asked for it: a browser keeps
     * it (it may be put in `localStorage`; on its own it authorizes nothing) and sends it back
     * with the link's token. A link opened anywhere else has no binding to send and proves nothing.
     */
    linkBinding: z.string().optional(),
    /** Present only when `step.status === 'complete'`. */
    session: SessionTokensSchema.optional(),
    /**
     * Present **only** in the response that confirms a second factor enrolled inside the attempt
     * (`factor-enrolment/totp/confirm`): the user's ten backup codes, shown this once and never
     * again. Show them to the user and keep them nowhere.
     */
    backupCodes: z.array(z.string()).optional(),
    /**
     * Present **only** when the attempt was completed with a backup code: how many unused
     * backup codes the user has left.
     */
    backupCodesRemaining: z.number().int().min(0).optional(),
  })
  .meta({ ref: 'FlowAttempt' })

/**
 * Start a sign-up with an email address and, unless the environment makes it optional
 * (`signUp.password: 'optional'`), a password. Without one the account is created with no
 * password and signs in with an emailed code or link.
 */
export const SignUpRequestSchema = z
  .object({
    email: z.string().max(320),
    password: z.string().max(1024).optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
  })
  .meta({ ref: 'SignUpRequest' })

/** Start a sign-in by identifying the user. */
export const SignInStartRequestSchema = z
  .object({ identifier: z.string().max(320) })
  .meta({ ref: 'SignInStartRequest' })

/**
 * Submit a password for a sign-in attempt waiting on `needs_password`, or on
 * `needs_first_factor` with `password` among its strategies.
 */
export const PasswordAttemptRequestSchema = z
  .object({ password: z.string().max(1024) })
  .meta({ ref: 'PasswordAttemptRequest' })

/** Longest redirect URL, link token or link binding a request may carry. */
const MAX_LINK_FIELD_LENGTH = 2048

/**
 * Ask for the email that proves an email first factor, for a sign-in on `needs_first_factor`.
 *
 * - `email_code`: a 6-digit code.
 * - `email_link`: the same code and a link to `redirectUrl`, which must be one of the
 *   environment's `urls.allowedRedirectUrls`, exactly. The link carries its token in the URL
 *   fragment and works only in the browser that asked for it.
 */
export const FirstFactorPrepareRequestSchema = z
  .object({
    strategy: EmailVerificationStrategySchema,
    /** Where the emailed link leads. Required for `email_link`, ignored for `email_code`. */
    redirectUrl: z.string().max(MAX_LINK_FIELD_LENGTH).optional(),
  })
  .meta({ ref: 'FirstFactorPrepareRequest' })

/**
 * Prove an email first factor.
 *
 * - `email_code`: the emailed code.
 * - `email_link`: nothing to submit. It asks whether the emailed link has been opened (in this
 *   browser) and completes the sign-in if so; until then the answer is the unchanged step.
 */
export const FirstFactorAttemptRequestSchema = z
  .discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('email_code'), code: z.string().regex(/^\d{6}$/) }),
    z.object({ strategy: z.literal('email_link') }),
  ])
  .meta({ ref: 'FirstFactorAttemptRequest' })

/**
 * What the page an emailed link leads to sends: the token and attempt id from the link's
 * fragment, and the binding this browser was given when it asked for the link.
 */
export const EmailLinkRequestSchema = z
  .object({
    token: z.string().min(1).max(MAX_LINK_FIELD_LENGTH),
    attemptId: z.uuid(),
    /** Absent in a browser that did not ask for the link; such a request proves nothing. */
    binding: z.string().max(MAX_LINK_FIELD_LENGTH).optional(),
  })
  .meta({ ref: 'EmailLinkRequest' })

/**
 * The link was accepted: the sign-in it belongs to may now be completed by the client that
 * started it. Carries no tokens: opening a link never signs the opener in by itself.
 */
export const EmailLinkResultSchema = z
  .object({ status: z.literal('verified') })
  .meta({ ref: 'EmailLinkResult' })

/** Submit an emailed verification code for an attempt waiting on `needs_email_verification`. */
export const VerifyEmailRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'VerifyEmailRequest' })

/** Longest backup code a request may carry: ten characters, generously padded with separators. */
const MAX_BACKUP_CODE_INPUT_LENGTH = 64

/**
 * Prove a second factor for an attempt waiting on `needs_second_factor`.
 *
 * - `totp`: the 6-digit code the authenticator app shows now.
 * - `backup_code`: one of the user's unused backup codes. Case, spaces and dashes are ignored.
 *   Each works once.
 * - `passkey`: an assertion for the options of `…/second-factor/passkey/options` (ADR 0027).
 */
export const SecondFactorRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }),
    z.object({
      method: z.literal('backup_code'),
      code: z.string().min(1).max(MAX_BACKUP_CODE_INPUT_LENGTH),
    }),
    z.object({ method: z.literal('passkey'), credential: PasskeyAssertionCredentialSchema }),
  ])
  .meta({ ref: 'SecondFactorRequest' })

/**
 * A started passkey sign-in (`POST /v1/client/sign-ins/passkey`): an attempt of its own, with
 * its secret, and the options to ask the authenticator with. The same for every caller.
 */
export const PasskeySignInStartSchema = z
  .object({ attempt: FlowAttemptSchema, options: PasskeyRequestOptionsSchema })
  .meta({ ref: 'PasskeySignInStart' })

/** Start a password reset for an email address. */
export const PasswordResetStartRequestSchema = z
  .object({ email: z.string().max(320) })
  .meta({ ref: 'PasswordResetStartRequest' })

/** Submit the emailed code and the new password for an attempt on `needs_new_password`. */
export const PasswordResetRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/), password: z.string().max(1024) })
  .meta({ ref: 'PasswordResetRequest' })

/** A started passkey sign-in. */
export type PasskeySignInStart = z.infer<typeof PasskeySignInStartSchema>
/** First-factor strategy. */
export type FirstFactorStrategy = z.infer<typeof FirstFactorStrategySchema>
/** Second-factor method. */
export type SecondFactorMethod = z.infer<typeof SecondFactorMethodSchema>
/** A second factor a user can enrol. */
export type FactorEnrolmentMethod = z.infer<typeof FactorEnrolmentMethodSchema>
/** Second-factor request body. */
export type SecondFactorRequest = z.infer<typeof SecondFactorRequestSchema>
/** Email verification strategy. */
export type EmailVerificationStrategy = z.infer<typeof EmailVerificationStrategySchema>
/** Server-decided next step. */
export type FlowStep = z.infer<typeof FlowStepSchema>
/** Flow kind. */
export type FlowKind = z.infer<typeof FlowKindSchema>
/** Issued session tokens. */
export type SessionTokens = z.infer<typeof SessionTokensSchema>

/**
 * The tokens of a `hybrid` session: {@link SessionTokens} with the access token present. What
 * every sign-in returns unless the environment made the session's profile `stateful`.
 */
export type HybridSessionTokens = SessionTokens &
  Required<Pick<SessionTokens, 'accessToken' | 'accessTokenExpiresAt'>>
/** A flow attempt. */
export type FlowAttempt = z.infer<typeof FlowAttemptSchema>
/** Sign-up request body. */
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>
/** Sign-in start request body. */
export type SignInStartRequest = z.infer<typeof SignInStartRequestSchema>
/** First-factor prepare request body. */
export type FirstFactorPrepareRequest = z.infer<typeof FirstFactorPrepareRequestSchema>
/** First-factor attempt request body. */
export type FirstFactorAttemptRequest = z.infer<typeof FirstFactorAttemptRequestSchema>
/** Emailed-link request body. */
export type EmailLinkRequest = z.infer<typeof EmailLinkRequestSchema>
/** Emailed-link result. */
export type EmailLinkResult = z.infer<typeof EmailLinkResultSchema>
/** Password attempt request body. */
export type PasswordAttemptRequest = z.infer<typeof PasswordAttemptRequestSchema>
/** Email verification request body. */
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>
/** Password reset start request body. */
export type PasswordResetStartRequest = z.infer<typeof PasswordResetStartRequestSchema>
/** Password reset request body. */
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>
