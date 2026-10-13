import { z } from 'zod'
import { PasskeyAssertionCredentialSchema } from './passkey'

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
    /**
     * A texted code as the second factor (ADR 0025). Optional in the schema, so a client
     * reading an older server's answer treats a missing one as "not offered".
     *
     * - `enabled`: the user has enrolled it. `enabledAt` says since when.
     * - `inUse`: it is what a sign-in and a step-up ask this user for. `false` while the user
     *   also has an authenticator app or a passkey: a texted code is never used beside one.
     * - `available`: the user could enrol it now (the environment offers it, the account has
     *   a proven phone number and nothing stronger).
     */
    sms: z
      .object({
        enabled: z.boolean(),
        enabledAt: z.iso.datetime().nullable(),
        inUse: z.boolean(),
        available: z.boolean(),
      })
      .optional(),
  })
  .meta({ ref: 'Factors' })

/**
 * A code was texted to the account's phone number, to enrol a texted code as the second
 * factor (`POST /v1/client/me/factors/sms`) or to step up with one
 * (`POST /v1/client/sessions/step-up/sms-code`). Never the code.
 */
export const SmsFactorCodeSchema = z
  .object({
    method: z.literal('sms_code'),
    /** The number it went to, masked: `***42`. */
    destination: z.string(),
    /** When the code stops working. */
    expiresAt: z.iso.datetime(),
  })
  .meta({ ref: 'SmsFactorCode' })

/** Confirm a texted code as the second factor with the 6-digit code that was texted. */
export const SmsFactorConfirmRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'SmsFactorConfirmRequest' })

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
 * email address and **no** second factor. `passkey` is an assertion for the options of
 * `POST /v1/client/sessions/step-up/passkey`, for a user who has a passkey (ADR 0027).
 * `sms_code` is a 6-digit code texted on request
 * (`POST /v1/client/sessions/step-up/sms-code`); it exists only for a user whose **only**
 * second factor is a texted code, never beside an authenticator app or a passkey.
 */
export const StepUpMethodSchema = z
  .enum(['password', 'totp', 'backup_code', 'email_code', 'passkey', 'sms_code'])
  .meta({ ref: 'StepUpMethod' })

/**
 * Prove a factor again for the current session (`POST /v1/client/sessions/step-up`).
 *
 * A user with two-step verification must use `totp`, `backup_code` or a `passkey` (or, where a
 * texted code is their only second factor, the `sms_code` they asked for from this session): their
 * password alone is refused. A user without it uses `password`, or an `email_code` they asked for from this
 * session.
 */
export const StepUpRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('password'), password: z.string().max(1024) }),
    z.object({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }),
    z.object({ method: z.literal('backup_code'), code: z.string().min(1).max(64) }),
    z.object({ method: z.literal('email_code'), code: z.string().regex(/^\d{6}$/) }),
    z.object({ method: z.literal('passkey'), credential: PasskeyAssertionCredentialSchema }),
    z.object({ method: z.literal('sms_code'), code: z.string().regex(/^\d{6}$/) }),
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
/** A texted second-factor code's receipt. */
export type SmsFactorCode = z.infer<typeof SmsFactorCodeSchema>
/** Texted-code factor confirmation request body. */
export type SmsFactorConfirmRequest = z.infer<typeof SmsFactorConfirmRequestSchema>
/** A step-up method. */
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>
/** An emailed step-up code's receipt. */
export type StepUpEmailCode = z.infer<typeof StepUpEmailCodeSchema>
/** Step-up request body. */
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>
