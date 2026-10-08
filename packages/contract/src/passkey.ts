import { z } from 'zod'

/** How many passkeys one user may have. */
export const MAX_PASSKEYS_PER_USER = 10

/** Longest name a user can give a passkey. */
export const MAX_PASSKEY_NAME_LENGTH = 64

/** Milliseconds a WebAuthn challenge is honoured for: five minutes, once. */
export const PASSKEY_CHALLENGE_TTL_MS = 300_000

/**
 * The COSE algorithms a passkey may use, in the order they are offered: ES256 (-7), EdDSA (-8)
 * and RS256 (-257).
 */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const

// Unpadded base64url, as WebAuthn's JSON forms use for every binary value.
const Base64Url = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/)

const Transports = z.array(z.string().max(32)).max(16)

const CredentialDescriptor = z.object({
  type: z.literal('public-key'),
  id: z.string(),
  transports: z.array(z.string()).optional(),
})

/**
 * A passkey of the signed-in user. Never key material and never the credential id.
 *
 * - `name`: what the user called it ("MacBook", "Phone").
 * - `synced`: the authenticator reports the credential as backed up (a passkey kept in a
 *   password manager or a platform account, usable from the user's other devices). `false`
 *   means it lives on one device.
 * - `lastUsedAt`: the last sign-in or step-up with it; `null` before the first.
 */
export const PasskeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    synced: z.boolean(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .meta({ ref: 'Passkey' })

/** The signed-in user's passkeys, oldest first. */
export const PasskeyListSchema = z
  .object({ passkeys: z.array(PasskeySchema) })
  .meta({ ref: 'PasskeyList' })

/**
 * Options for `navigator.credentials.create()`, in WebAuthn's JSON form
 * (`PublicKeyCredentialCreationOptionsJSON`): pass them to
 * `PublicKeyCredential.parseCreationOptionsFromJSON`. Binary values are unpadded base64url.
 *
 * The challenge is 32 random bytes, works once and for five minutes, and is bound to the
 * session that asked. `user.id` is an opaque 32-byte handle: a keyed hash (HMAC) of the
 * environment and the user, the same for every passkey of one user, which reveals neither the
 * email nor the user id without the server's key.
 */
export const PasskeyCreationOptionsSchema = z
  .object({
    rp: z.object({ id: z.string(), name: z.string() }),
    user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
    challenge: z.string(),
    pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() })),
    timeout: z.number().int(),
    excludeCredentials: z.array(CredentialDescriptor),
    authenticatorSelection: z.object({
      residentKey: z.literal('required'),
      requireResidentKey: z.literal(true),
      userVerification: z.literal('required'),
    }),
    attestation: z.literal('none'),
  })
  .meta({ ref: 'PasskeyCreationOptions' })

/**
 * Options for `navigator.credentials.get()`, in WebAuthn's JSON form
 * (`PublicKeyCredentialRequestOptionsJSON`): pass them to
 * `PublicKeyCredential.parseRequestOptionsFromJSON`.
 *
 * A sign-in's options never carry `allowCredentials`: the credential is discoverable, so the
 * options are the same for every caller and say nothing about any account. A second factor's
 * and a step-up's list the user's own passkeys, to someone who has already proven who they are.
 */
export const PasskeyRequestOptionsSchema = z
  .object({
    challenge: z.string(),
    timeout: z.number().int(),
    rpId: z.string(),
    userVerification: z.literal('required'),
    allowCredentials: z.array(CredentialDescriptor).optional(),
  })
  .meta({ ref: 'PasskeyRequestOptions' })

/**
 * What `navigator.credentials.create()` returned, as `PublicKeyCredential.toJSON()` gives it
 * (`RegistrationResponseJSON`). Unknown members are kept: a browser may add some.
 */
export const PasskeyRegistrationCredentialSchema = z
  .looseObject({
    id: Base64Url.max(1366),
    rawId: Base64Url.max(1366),
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: Base64Url,
      attestationObject: Base64Url,
      transports: Transports.optional(),
    }),
  })
  .meta({ ref: 'PasskeyRegistrationCredential' })

/**
 * What `navigator.credentials.get()` returned, as `PublicKeyCredential.toJSON()` gives it
 * (`AuthenticationResponseJSON`). Unknown members are kept.
 */
export const PasskeyAssertionCredentialSchema = z
  .looseObject({
    id: Base64Url.max(1366),
    rawId: Base64Url.max(1366),
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: Base64Url,
      authenticatorData: Base64Url,
      signature: Base64Url,
      userHandle: Base64Url.max(128).nullish(),
    }),
  })
  .meta({ ref: 'PasskeyAssertionCredential' })

const PasskeyName = z.string().trim().min(1).max(MAX_PASSKEY_NAME_LENGTH)

/**
 * Finish registering a passkey (`POST /v1/client/me/passkeys`): the credential the browser
 * made for the options of `POST /v1/client/me/passkeys/options`, and an optional name.
 */
export const PasskeyRegisterRequestSchema = z
  .object({ credential: PasskeyRegistrationCredentialSchema, name: PasskeyName.optional() })
  .meta({ ref: 'PasskeyRegisterRequest' })

/** Rename a passkey (`PATCH /v1/client/me/passkeys/:passkeyId`). */
export const PasskeyRenameRequestSchema = z
  .object({ name: PasskeyName })
  .meta({ ref: 'PasskeyRenameRequest' })

/** Prove a passkey for a sign-in attempt (`POST /v1/client/sign-ins/:attemptId/passkey`). */
export const PasskeySignInRequestSchema = z
  .object({ credential: PasskeyAssertionCredentialSchema })
  .meta({ ref: 'PasskeySignInRequest' })

/** A passkey. */
export type Passkey = z.infer<typeof PasskeySchema>
/** A user's passkeys. */
export type PasskeyList = z.infer<typeof PasskeyListSchema>
/** Options for creating a passkey. */
export type PasskeyCreationOptions = z.infer<typeof PasskeyCreationOptionsSchema>
/** Options for asking for a passkey. */
export type PasskeyRequestOptions = z.infer<typeof PasskeyRequestOptionsSchema>
/** A browser's registration response. */
export type PasskeyRegistrationCredential = z.infer<typeof PasskeyRegistrationCredentialSchema>
/** A browser's assertion response. */
export type PasskeyAssertionCredential = z.infer<typeof PasskeyAssertionCredentialSchema>
/** Passkey registration request body. */
export type PasskeyRegisterRequest = z.infer<typeof PasskeyRegisterRequestSchema>
/** Passkey rename request body. */
export type PasskeyRenameRequest = z.infer<typeof PasskeyRenameRequestSchema>
/** Passkey sign-in request body. */
export type PasskeySignInRequest = z.infer<typeof PasskeySignInRequestSchema>
