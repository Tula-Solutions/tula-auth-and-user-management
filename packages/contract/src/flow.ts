import { z } from 'zod'

/** Second-factor methods a flow can ask for. */
export const SecondFactorMethodSchema = z
  .enum(['totp', 'passkey', 'backup_code', 'sms_code'])
  .meta({ ref: 'SecondFactorMethod' })

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
      status: z.literal('needs_email_verification'),
      /** Masked destination, e.g. `m***@northline.app`. */
      destination: z.string(),
      strategies: z.array(EmailVerificationStrategySchema).min(1),
    }),
    z.object({
      status: z.literal('needs_second_factor'),
      options: z.array(SecondFactorMethodSchema).min(1),
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

/** Whether an attempt signs an existing user in or creates a new one. */
export const FlowKindSchema = z.enum(['sign_in', 'sign_up']).meta({ ref: 'FlowKind' })

/**
 * Tokens issued when a flow completes or a session is refreshed.
 *
 * `refreshToken` is only present for native/server clients. Browsers receive it as an httpOnly
 * cookie and never see it in JavaScript.
 */
export const SessionTokensSchema = z
  .object({
    sessionId: z.string(),
    accessToken: z.string(),
    accessTokenExpiresAt: z.iso.datetime(),
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
    /** Present only when `step.status === 'complete'`. */
    session: SessionTokensSchema.optional(),
  })
  .meta({ ref: 'FlowAttempt' })

/** Start a sign-up with email and password. */
export const SignUpRequestSchema = z
  .object({
    email: z.string().max(320),
    password: z.string().max(1024),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
  })
  .meta({ ref: 'SignUpRequest' })

/** Start a sign-in by identifying the user. */
export const SignInStartRequestSchema = z
  .object({ identifier: z.string().max(320) })
  .meta({ ref: 'SignInStartRequest' })

/** Submit a password for a sign-in attempt waiting on `needs_password`. */
export const PasswordAttemptRequestSchema = z
  .object({ password: z.string().max(1024) })
  .meta({ ref: 'PasswordAttemptRequest' })

/** Submit an emailed verification code for an attempt waiting on `needs_email_verification`. */
export const VerifyEmailRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'VerifyEmailRequest' })

/** Second-factor method. */
export type SecondFactorMethod = z.infer<typeof SecondFactorMethodSchema>
/** Email verification strategy. */
export type EmailVerificationStrategy = z.infer<typeof EmailVerificationStrategySchema>
/** Server-decided next step. */
export type FlowStep = z.infer<typeof FlowStepSchema>
/** Flow kind. */
export type FlowKind = z.infer<typeof FlowKindSchema>
/** Issued session tokens. */
export type SessionTokens = z.infer<typeof SessionTokensSchema>
/** A flow attempt. */
export type FlowAttempt = z.infer<typeof FlowAttemptSchema>
/** Sign-up request body. */
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>
/** Sign-in start request body. */
export type SignInStartRequest = z.infer<typeof SignInStartRequestSchema>
/** Password attempt request body. */
export type PasswordAttemptRequest = z.infer<typeof PasswordAttemptRequestSchema>
/** Email verification request body. */
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>
