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
  // The new password is one of the account's last `params.history` passwords, the current one
  // included (ADR 0038). Only ever told to someone who has already proven the account is theirs.
  'password.reused': {
    status: 422,
    message: 'You have used this password recently. Choose a different one.',
  },
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
  // The environment's `mfa.policy` is `required`, the user has no second factor, and all the
  // sign-in proved is a texted code. A phone number alone must not be what enrols an account's
  // second factor (ADR 0037): sign in another way.
  'mfa.enrolment_needs_other_sign_in': {
    status: 403,
    message: 'Sign in another way to set up two-step verification.',
  },
  // A texted code is the account's only second factor and all the sign-in proved is a texted
  // code to the same number: one phone is not two steps (ADR 0025). Sign in another way first.
  'mfa.needs_other_sign_in': {
    status: 403,
    message: 'Sign in another way. A texted code cannot be both steps.',
  },
  // A texted code is never a second factor beside an authenticator app or a passkey.
  'mfa.sms_not_allowed': {
    status: 409,
    message: 'This account already has a stronger second step than a texted code.',
  },
  // Enrolling a texted code as the second factor needs a phone number on the account.
  'mfa.phone_number_required': {
    status: 409,
    message: 'Add a phone number to your account first.',
  },
  // The environment's `mfa.policy` is `required`: a user cannot turn their second factor off.
  'mfa.required_by_policy': {
    status: 403,
    message: 'This app requires two-step verification. It cannot be turned off.',
  },

  // Signing in with an OAuth provider (ADR 0026). None of these says anything about an account
  // except `oauth.account_exists`, which is only ever told to someone the provider vouches
  // controls that verified address.
  'oauth.access_denied': {
    status: 403,
    message: 'Sign-in was cancelled. Try again or choose another way to sign in.',
  },
  'oauth.provider_error': {
    status: 502,
    message: 'The sign-in provider could not complete the request. Try again.',
  },
  // The provider's answer could not be matched to a sign-in: an unknown, used or expired state.
  'oauth.state_invalid': {
    status: 400,
    message: 'This sign-in could not be completed. Start again.',
  },
  // The ticket the app's page presented is unknown, used or older than a minute.
  'oauth.ticket_invalid': {
    status: 410,
    message: 'This sign-in has expired. Start again.',
  },
  // The ticket was presented without the binding of the browser that started the sign-in.
  // Nothing was completed and nothing was used up.
  'oauth.different_browser': {
    status: 409,
    message: 'Finish signing in in the browser where you started, or start again here.',
  },
  'oauth.email_missing': {
    status: 403,
    message:
      'This provider did not share an email address. Allow access to your email and try again.',
  },
  'oauth.email_unverified': {
    status: 403,
    message:
      'Your email address is not verified with this provider. Verify it there and try again.',
  },
  // The provider's verified address belongs to an account that this provider account cannot
  // be connected to automatically.
  'oauth.account_exists': {
    status: 409,
    message:
      'An account with this email already exists. Sign in the way you usually do, then connect this provider from your account.',
  },
  'oauth.identity_in_use': {
    status: 409,
    message: 'This provider account is already connected to another user.',
  },
  'oauth.already_linked': {
    status: 409,
    message: 'An account of this provider is already connected. Disconnect it first.',
  },
  // Disconnecting the provider account would leave the user with no way to sign in.
  'identity.last_sign_in_method': {
    status: 409,
    message: 'This is your only way to sign in. Add a password or connect another account first.',
  },

  // A webhook endpoint's address is not one the server may call (ADR 0034): not `https`,
  // credentials in it, or a host that does not resolve to public addresses only.
  // `params.reason` is a fixed word saying which rule; never the address or what it resolved to.
  'webhook.url_not_allowed': {
    status: 422,
    message: 'The server cannot deliver to that address.',
  },
  // A past delivery cannot be sent again (ADR 0034). `params.reason` is a fixed word saying
  // why: `delivery_pending` (the server is still retrying it), `endpoint_disabled` (nothing
  // is sent to an endpoint that is off), `event_gone` (its payload is no longer kept) or
  // `attempt_limit` (the delivery has had as many requests as one may have).
  'webhook.cannot_redeliver': {
    status: 409,
    message: 'This delivery cannot be sent again.',
  },
  // A signing secret cannot be replaced, or its overlap ended, right now (ADR 0034).
  // `params.reason` is a fixed word: `rotation_in_progress` (two secrets already sign),
  // `no_rotation_in_progress` (there is no previous secret to revoke) or `secret_unreadable`
  // (the server cannot open the current secret, so it could not keep signing).
  'webhook.rotation_refused': {
    status: 409,
    message: 'The signing secret cannot be changed now.',
  },

  // Hooks (ADR 0035). The operator's hook refused a sign-up (`before_sign_up`) or a sign-in
  // (`before_session`); `params.code` is the hook's own message code when it gave one, for
  // the app to turn into words. Answered only where the address, or every factor, was
  // already proven, so it says nothing about any account. One code for both points: a client
  // knows which of the two it was doing, and the words name neither.
  'hook.denied': { status: 403, message: 'This was not allowed.' },
  // A hook could not be asked or gave no usable answer, and it refuses on failure. Nothing
  // was created; trying again later may work.
  'hook.unavailable': {
    status: 503,
    message: 'This is unavailable right now. Try again later.',
  },
  // A hook's address is not one the server may call: as `webhook.url_not_allowed`.
  'hook.url_not_allowed': { status: 422, message: 'The server cannot call that address.' },

  // Passkeys (ADR 0027). A failed passkey sign-in is always `auth.invalid_credentials`.
  'passkey.registration_failed': {
    status: 422,
    message: 'That passkey could not be saved. Try again.',
  },
  'passkey.already_registered': {
    status: 409,
    message: 'This passkey is already saved to an account.',
  },
  'passkey.limit_reached': {
    status: 409,
    message: 'You have reached the number of passkeys an account can have. Remove one first.',
  },
  // Removing the passkey would leave the user with no way to sign in.
  'passkey.last_sign_in_method': {
    status: 409,
    message: 'This is your only way to sign in. Add a password or connect an account first.',
  },

  // Phone numbers and SMS (ADR 0037). Both refusals of a send are answered to the signed-in
  // owner of the request, about the environment and the number they typed: neither says
  // anything about another account.
  'phone.invalid': {
    status: 422,
    message: 'Enter a phone number with its country code, such as +14155550100.',
  },
  // The environment's settings have SMS off (`sms.enabled`), or allow no country at all.
  'sms.disabled': { status: 403, message: 'Text messages are not available.' },
  // The number's country is not in the environment's `sms.allowedCountries`. Nothing was sent.
  'sms.country_not_allowed': {
    status: 422,
    message: 'Text messages cannot be sent to that country.',
  },
  // The message could not be handed to a sender (none is configured, or it failed). Nothing
  // was stored: an earlier code keeps working.
  'sms.unavailable': {
    status: 503,
    message: 'The text message could not be sent. Try again later.',
  },

  'session.invalid_token': { status: 401, message: 'Your session is invalid. Sign in again.' },
  'session.expired': { status: 401, message: 'Your session has expired. Sign in again.' },
  'session.revoked': { status: 401, message: 'Your session was signed out. Sign in again.' },
  'session.reuse_detected': {
    status: 401,
    message: 'For your security this session was signed out. Sign in again.',
  },
  // The environment limits how many sessions one user may have (`sessions.maxPerUser`) and
  // refuses the newest (`sessions.onLimit: refuse_newest`). Answered only after every factor
  // was proven, so it says nothing to someone who cannot sign in anyway. No session exists.
  'session.limit_reached': {
    status: 403,
    message:
      'You are signed in on too many devices. Sign out on another device, or reset your password to sign out everywhere, then try again.',
  },

  // Device binding (ADR 0043). None of the three is a `session.*` code, on purpose: a session
  // whose refresh is refused for its proof is still alive, and a client must not sign out.
  //
  // A proof (the `DPoP` header) is missing where the session is bound to a key, or is not a
  // valid proof for that key and this request. Nothing was rotated and the session lives on.
  'device.proof_invalid': {
    status: 401,
    message: 'This session is bound to a device key, and the request did not prove that key.',
  },
  // The proof's nonce is missing or too old. The answer carries a fresh one in the
  // `DPoP-Nonce` header: make a new proof with it and send the request again.
  'device.nonce_required': {
    status: 400,
    message: 'The proof needs a fresh nonce. Send the request again with the nonce provided.',
  },
  // A proof was sent where a session cannot be bound: by a browser (`x-tula-client: web`),
  // or to a deployment whose own public URL no proof can name (ADR 0043).
  'device.binding_not_supported': {
    status: 400,
    message: 'A session of this kind of client cannot be bound to a device key.',
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
