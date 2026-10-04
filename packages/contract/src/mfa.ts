import { z } from 'zod'

/** Digits in an authenticator (TOTP) code. */
export const TOTP_DIGITS = 6

/** Seconds one authenticator code is valid for (the RFC 6238 time step). */
export const TOTP_PERIOD_SECONDS = 30

/** How many backup codes a user holds after turning two-step verification on or regenerating. */
export const BACKUP_CODE_COUNT = 10

/**
 * What a signed-in user has enrolled as a second factor. Never contains a secret.
 *
 * `totp.enabled` is true once an authenticator app was confirmed with a code; an enrolment that
 * was started and not confirmed does not count. `backupCodes.remaining` is how many unused
 * backup codes are left.
 */
export const FactorsSchema = z
  .object({
    totp: z.object({ enabled: z.boolean(), confirmedAt: z.iso.datetime().nullable() }),
    backupCodes: z.object({ remaining: z.number().int().min(0) }),
  })
  .meta({ ref: 'Factors' })

/**
 * A started authenticator enrolment, returned **once**.
 *
 * - `secret`: the shared secret, Base32 (RFC 4648, no padding), for typing into an app by hand.
 * - `uri`: the same secret as an `otpauth://totp/…` URI, for a QR code.
 *
 * Both are secrets: show them to the user and keep them nowhere. The enrolment counts for
 * nothing until it is confirmed with a code, and expires after ten minutes.
 */
export const TotpEnrolmentSchema = z
  .object({ secret: z.string(), uri: z.string() })
  .meta({ ref: 'TotpEnrolment' })

/** Confirm a started authenticator enrolment with the 6-digit code the app shows now. */
export const TotpConfirmRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'TotpConfirmRequest' })

/**
 * A fresh set of backup codes, returned **once**: each is ten characters shown as
 * `xxxxx-xxxxx` and signs the user in one time when their authenticator is unavailable. The
 * server keeps only keyed hashes; they can be replaced but never shown again.
 */
export const BackupCodesSchema = z
  .object({ codes: z.array(z.string()) })
  .meta({ ref: 'BackupCodes' })

/**
 * What a step-up can be proven with.
 *
 * `email_code` is a 6-digit code emailed on request
 * (`POST /v1/client/sessions/step-up/email-code`); it exists only for a user with a verified
 * email address and **no** second factor.
 */
export const StepUpMethodSchema = z
  .enum(['password', 'totp', 'backup_code', 'email_code'])
  .meta({ ref: 'StepUpMethod' })

/**
 * Prove a factor again for the current session (`POST /v1/client/sessions/step-up`).
 *
 * A user with two-step verification must use `totp` or `backup_code`: their password alone is
 * refused. A user without it uses `password`, or an `email_code` they asked for from this
 * session.
 */
export const StepUpRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('password'), password: z.string().max(1024) }),
    z.object({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }),
    z.object({ method: z.literal('backup_code'), code: z.string().min(1).max(64) }),
    z.object({ method: z.literal('email_code'), code: z.string().regex(/^\d{6}$/) }),
  ])
  .meta({ ref: 'StepUpRequest' })

/**
 * A step-up code was emailed (`POST /v1/client/sessions/step-up/email-code`). Never the code.
 *
 * The code works for ten minutes, a few guesses, once, and only for the session that asked.
 */
export const StepUpEmailCodeSchema = z
  .object({
    method: z.literal('email_code'),
    /** The address it went to, masked: `m***@northline.app`. */
    destination: z.string(),
    /** When the code stops working. */
    expiresAt: z.iso.datetime(),
  })
  .meta({ ref: 'StepUpEmailCode' })

/** Enrolled second factors. */
export type Factors = z.infer<typeof FactorsSchema>
/** A started authenticator enrolment. */
export type TotpEnrolment = z.infer<typeof TotpEnrolmentSchema>
/** Authenticator confirmation request body. */
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequestSchema>
/** A fresh set of backup codes. */
export type BackupCodes = z.infer<typeof BackupCodesSchema>
/** A step-up method. */
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>
/** An emailed step-up code's receipt. */
export type StepUpEmailCode = z.infer<typeof StepUpEmailCodeSchema>
/** Step-up request body. */
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>
