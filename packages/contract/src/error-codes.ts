/**
 * The error codes of the public contract, as plain data.
 *
 * This module has no dependencies (no Zod), so an SDK can import it from
 * `@tula/contract/error-codes` without adding a schema library to an application's bundle. The
 * Zod schemas built on these codes live in `./errors`.
 */

/** Definition of one contract error code: its HTTP status and default (English) message. */
export interface ErrorDefinition {
  /** HTTP status the API responds with for this code. */
  readonly status: number
  /** Default human-readable message; SDKs may localize by `code`. */
  readonly message: string
}

/**
 * Every machine-readable error code the API can return, keyed `area.reason`.
 *
 * Codes are part of the public contract: SDKs switch on them and translate them, so they are
 * append-only. Removing or renaming one is a breaking change.
 *
 * Sign-up deliberately has no "email already taken" code: an existing address still receives
 * `needs_email_verification` (and a notice email) so sign-up can't be used to enumerate accounts.
 */
export const ERROR_DEFINITIONS = {
  'auth.invalid_credentials': { status: 401, message: 'The email or password is incorrect.' },
  'auth.unauthenticated': { status: 401, message: 'You need to sign in to do that.' },
  'auth.invalid_key': { status: 401, message: 'The API key is missing, invalid or revoked.' },
  'auth.forbidden': { status: 403, message: 'You do not have permission to do that.' },
  'auth.user_banned': { status: 403, message: 'This account has been disabled.' },
  // The environment's settings switch this sign-in method off (`signIn.methods`). It says
  // nothing about any account, so it is safe to report before an identifier is looked up.
  'auth.method_disabled': { status: 403, message: 'This sign-in method is not available.' },
  // A sensitive action by a signed-in user whose last proof of identity is too old (or, for a
  // user with two-step verification, did not include the second factor). `params.methods` is a
  // comma-separated list of what `POST /v1/client/sessions/step-up` accepts from this user
  // (`password`, `totp`, `backup_code`); empty when the only way is to sign in again.
  'auth.step_up_required': {
    status: 403,
    message: 'Confirm it is you to continue.',
  },

  'flow.not_found': { status: 404, message: 'This attempt does not exist or has expired.' },
  'flow.invalid_step': {
    status: 409,
    message: 'That action is not valid at this step. Please start again.',
  },

  'email.invalid': { status: 422, message: 'Enter a valid email address.' },

  'password.too_short': { status: 422, message: 'Password is too short.' },
  'password.too_long': { status: 422, message: 'Password is too long.' },
  'password.missing_lowercase': { status: 422, message: 'Add a lowercase letter.' },
  'password.missing_uppercase': { status: 422, message: 'Add an uppercase letter.' },
  'password.missing_number': { status: 422, message: 'Add a number.' },
  'password.missing_special': { status: 422, message: 'Add a special character.' },
  'password.too_few_character_classes': {
    status: 422,
    message: 'Use a wider mix of letters, numbers and symbols.',
  },
  'password.contains_user_info': {
    status: 422,
    message: 'Password must not contain your name or email.',
  },
  'password.common': { status: 422, message: 'This password is too common.' },
  'password.breached': {
    status: 422,
    message: 'This password appeared in a data breach. Choose a different one.',
  },
  'password.repeated_characters': {
    status: 422,
    message: 'Avoid repeating the same character.',
  },
  'password.sequence': { status: 422, message: 'Avoid sequences like "abcd" or "1234".' },
  // "Change my password" on an account that has none (it signs in another way). Only ever told
  // to the signed-in user about their own account.
  'password.not_set': {
    status: 409,
    message: 'This account has no password yet. Use "forgot password" to set one.',
  },

  'verification.invalid_code': { status: 422, message: 'That code is incorrect.' },
  'verification.expired': { status: 410, message: 'That code has expired. Request a new one.' },
  'verification.too_many_attempts': {
    status: 429,
    message: 'Too many incorrect codes. Request a new one.',
  },

  // An emailed sign-in link opened in a browser other than the one that asked for it. Nothing
  // was used up: the link still works where it was requested, and so does the code beside it.
  'verification.different_browser': {
    status: 409,
    message:
      'Open this link in the browser where you started signing in, or enter the code from the email there.',
  },

  // A wrong authenticator or backup code. Deliberately not `verification.invalid_code`: that one
  // is about an emailed code, which can be resent; this one cannot.
  'mfa.invalid_code': { status: 422, message: 'That code is incorrect.' },
  'mfa.already_enabled': {
    status: 409,
    message: 'Two-step verification is already on for this account.',
  },
  'mfa.not_enabled': {
    status: 409,
    message: 'Two-step verification is not on for this account.',
  },
  // Confirming an enrolment that was never started, was already confirmed, or was started more
  // than ten minutes ago.
  'mfa.enrolment_expired': {
    status: 410,
    message: 'This setup has expired. Start again.',
  },
  // The environment's `mfa.policy` is `off`: nobody can enrol.
  'mfa.not_available': {
    status: 403,
    message: 'Two-step verification is not available for this app.',
  },
  // The environment's `mfa.policy` is `required`: a user cannot turn their second factor off.
  'mfa.required_by_policy': {
    status: 403,
    message: 'This app requires two-step verification. It cannot be turned off.',
  },

  'session.invalid_token': { status: 401, message: 'Your session is invalid. Sign in again.' },
  'session.expired': { status: 401, message: 'Your session has expired. Sign in again.' },
  'session.revoked': { status: 401, message: 'Your session was signed out. Sign in again.' },
  'session.reuse_detected': {
    status: 401,
    message: 'For your security this session was signed out. Sign in again.',
  },

  rate_limited: { status: 429, message: 'Too many requests. Try again shortly.' },
  'request.malformed': { status: 400, message: 'The request could not be read.' },
  'request.too_large': { status: 413, message: 'The request body is too large.' },
  // A browser flow (`x-tula-client: web`) called from a page whose origin the environment does
  // not allow (`urls.allowedOrigins`). Refused before anything changes, so such a page can
  // neither start a sign-in nor have a session cookie set by finishing one.
  'request.origin_not_allowed': {
    status: 403,
    message: 'This origin is not allowed to sign in to this app.',
  },
  // An emailed sign-in link was asked for with a `redirectUrl` that is not, exactly, one of the
  // environment's `urls.allowedRedirectUrls`. Says nothing about any account.
  'request.redirect_not_allowed': {
    status: 400,
    message: 'This redirect URL is not allowed for this app.',
  },
  'validation.failed': { status: 422, message: 'Some fields are invalid.' },
  'resource.not_found': { status: 404, message: 'The requested resource does not exist.' },
  'resource.conflict': { status: 409, message: 'The resource conflicts with existing data.' },
  // Conditional writes (`PUT /v1/admin/settings`): the request must say which revision it
  // changes (`If-Match`), and is refused when that revision is no longer the current one.
  'precondition.required': {
    status: 428,
    message: 'Send the revision you are changing in an If-Match header.',
  },
  'precondition.failed': {
    status: 412,
    message: 'The resource changed since you read it. Read it again and retry.',
  },
  not_implemented: { status: 501, message: 'This capability is not available yet.' },
  // A dependency the request needs to be decided safely (the shared rate-limit, lockout and
  // revoked-session store) cannot be reached. Nothing was changed; the same request can be retried.
  'service.unavailable': {
    status: 503,
    message: 'The service is temporarily unavailable. Try again shortly.',
  },
  internal: { status: 500, message: 'Something went wrong on our side.' },
} as const satisfies Record<string, ErrorDefinition>

/** A stable, machine-readable error code (e.g. `password.too_short`). */
export type ErrorCode = keyof typeof ERROR_DEFINITIONS

/** All error codes, for building enums in generated clients. */
export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]]

/**
 * Look up the HTTP status and default message for an error code.
 *
 * @param code - The contract error code.
 * @returns Its definition.
 *
 * @example
 * ```ts
 * errorDefinition('password.too_short').status // 422
 * ```
 */
export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_DEFINITIONS[code]
}
