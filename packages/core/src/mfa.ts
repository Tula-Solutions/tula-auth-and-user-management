import type { Schemas } from './generated/api.gen'

// Guards for the answers of the two-step verification routes. A 200 is not proof of talking to
// the API (a wrong `baseUrl` or a proxy's page answers 200 too), so each answer is checked
// before it is handed to the caller. Nothing here keeps what it checks: a TOTP secret, its URI
// and backup codes go to the caller and are stored nowhere in the client.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a set of backup codes: a non-empty list of non-empty strings.
 *
 * @param value - The `codes` of a backup-codes answer, or a completed attempt's `backupCodes`.
 * @returns `true` when every entry is a code.
 */
export function isCodes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((code) => typeof code === 'string' && code !== '')
  )
}

/**
 * Whether a value is the answer of confirming an authenticator or of making new backup codes.
 *
 * @param value - The parsed body.
 * @returns `true` when it carries backup codes.
 */
export function isBackupCodes(value: unknown): value is Schemas['BackupCodes'] {
  return isRecord(value) && isCodes(value.codes)
}

/**
 * Whether a value is a started authenticator enrolment: a secret and its `otpauth://` URI.
 *
 * @param value - The parsed body.
 * @returns `true` when both are there.
 */
export function isTotpEnrolment(value: unknown): value is Schemas['TotpEnrolment'] {
  return (
    isRecord(value) &&
    typeof value.secret === 'string' &&
    value.secret !== '' &&
    typeof value.uri === 'string' &&
    value.uri.startsWith('otpauth://')
  )
}

/**
 * Whether a value says what a user has enrolled as a second factor.
 *
 * @param value - The parsed body.
 * @returns `true` when it has the authenticator's state and the count of backup codes.
 */
export function isFactors(value: unknown): value is Schemas['Factors'] {
  return (
    isRecord(value) &&
    isRecord(value.totp) &&
    typeof value.totp.enabled === 'boolean' &&
    (value.totp.confirmedAt === null || typeof value.totp.confirmedAt === 'string') &&
    isRecord(value.backupCodes) &&
    typeof value.backupCodes.remaining === 'number'
  )
}

/**
 * Whether a value is the receipt of a code texted to a phone number.
 *
 * @param value - The parsed body.
 * @returns `true` when it names a destination and an expiry.
 */
export function isPhoneCodeSent(value: unknown): value is Schemas['PhoneCodeSent'] {
  return (
    isRecord(value) && typeof value.destination === 'string' && typeof value.expiresAt === 'string'
  )
}

/**
 * Whether a value is the receipt of a code sent for a step-up or for enrolling a texted code:
 * emailed (`email_code`) or texted (`sms_code`).
 *
 * @param value - The parsed body.
 * @returns `true` when it names one of the two methods, a destination and an expiry.
 */
export function isStepUpPrepared(
  value: unknown
): value is Schemas['StepUpEmailCode'] | Schemas['SmsFactorCode'] {
  const method = isRecord(value) ? value.method : null
  return isPhoneCodeSent(value) && (method === 'email_code' || method === 'sms_code')
}
