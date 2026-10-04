import { clientError, type Messages } from './errors'
import type { Schemas } from './generated/api.gen'

// WebAuthn in the browser, with no dependency: the options the API issues are turned into what
// `navigator.credentials` takes, and what it returns into the JSON the API verifies. Where the
// browser has `PublicKeyCredential.parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`
// and `toJSON`, they are used; otherwise the same conversions are done here.
//
// Nothing of a ceremony is kept: not the challenge, not the response. A failure is one of four
// client codes and never carries the credential.

/** Options for creating a passkey, as the API issues them. */
export type PasskeyCreationOptions = Schemas['PasskeyCreationOptions']
/** Options for asking for a passkey, as the API issues them. */
export type PasskeyRequestOptions = Schemas['PasskeyRequestOptions']
/** What the browser made, as the API takes it. */
export type PasskeyRegistrationCredential = Schemas['PasskeyRegistrationCredential']
/** What the browser signed, as the API takes it. */
export type PasskeyAssertionCredential = Schemas['PasskeyAssertionCredential']

/** How one request for a passkey is made. */
export interface PasskeyRequest {
  /** Ends the ceremony: the call rejects with `passkey.cancelled`. */
  signal?: AbortSignal
  /**
   * Ask through the browser's autofill instead of a dialog (conditional mediation): the
   * request waits, without any UI of its own, until the user picks a passkey offered on a
   * field with `autocomplete="username webauthn"`.
   */
  autofill?: boolean
}

/** The WebAuthn ceremonies a runtime can perform. Absent where it has no WebAuthn. */
export interface PasskeyAuthenticator {
  /** Whether the browser can offer passkeys in a field's autofill. */
  autofillAvailable(): Promise<boolean>
  /** `navigator.credentials.create()`, JSON in and JSON out. */
  create(
    options: PasskeyCreationOptions,
    request?: Pick<PasskeyRequest, 'signal'>
  ): Promise<PasskeyRegistrationCredential>
  /** `navigator.credentials.get()`, JSON in and JSON out. */
  get(options: PasskeyRequestOptions, request?: PasskeyRequest): Promise<PasskeyAssertionCredential>
}

/** The globals WebAuthn needs, as far as this module uses them. */
export interface PasskeyGlobals {
  navigator?: {
    credentials?: {
      create?(options: unknown): Promise<unknown>
      get?(options: unknown): Promise<unknown>
    }
  }
  PublicKeyCredential?: {
    parseCreationOptionsFromJSON?(options: unknown): unknown
    parseRequestOptionsFromJSON?(options: unknown): unknown
    isConditionalMediationAvailable?(): Promise<boolean>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode unpadded base64url into bytes.
 *
 * @param text - The encoded value.
 * @returns The bytes, in a buffer of their own.
 */
export function base64UrlToBytes(text: string): ArrayBuffer {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

/**
 * Encode bytes as unpadded base64url.
 *
 * @param buffer - The bytes.
 * @returns The text WebAuthn's JSON forms use for a binary value.
 */
export function bytesToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function descriptors(list: unknown): unknown[] | undefined {
  return Array.isArray(list)
    ? list.map((entry) =>
        isRecord(entry) && typeof entry.id === 'string'
          ? { ...entry, id: base64UrlToBytes(entry.id) }
          : entry
      )
    : undefined
}

/** `PublicKeyCredential.parseCreationOptionsFromJSON`, for a browser without it. */
function creationOptionsFromJson(options: PasskeyCreationOptions): unknown {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
    excludeCredentials: descriptors(options.excludeCredentials),
  }
}

/** `PublicKeyCredential.parseRequestOptionsFromJSON`, for a browser without it. */
function requestOptionsFromJson(options: PasskeyRequestOptions): unknown {
  const allow = descriptors(options.allowCredentials)
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    ...(allow && { allowCredentials: allow }),
  }
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/** `PublicKeyCredential.prototype.toJSON`, for a browser without it. */
function credentialToJson(credential: Record<string, unknown>): unknown {
  const response = isRecord(credential.response) ? credential.response : {}
  const encoded: Record<string, unknown> = {}
  for (const name of [
    'clientDataJSON',
    'attestationObject',
    'authenticatorData',
    'signature',
    'userHandle',
  ]) {
    const value = response[name]
    if (isBinary(value)) {
      encoded[name] = bytesToBase64Url(value)
    }
  }
  const transports = call(response, 'getTransports')
  if (Array.isArray(transports)) {
    encoded.transports = transports
  }
  const attachment = credential.authenticatorAttachment
  return {
    id: credential.id,
    rawId: isBinary(credential.rawId) ? bytesToBase64Url(credential.rawId) : credential.id,
    type: credential.type,
    response: encoded,
    ...(typeof attachment === 'string' && { authenticatorAttachment: attachment }),
    clientExtensionResults: call(credential, 'getClientExtensionResults') ?? {},
  }
}

/** Call a method of a platform object if it has one. Works on prototype methods too. */
function call(target: Record<string, unknown>, method: string): unknown {
  const candidate = target[method]
  return typeof candidate === 'function' ? candidate.call(target) : undefined
}

function toJson(credential: unknown): unknown {
  if (!isRecord(credential)) {
    return null
  }
  if (typeof credential.toJSON === 'function') {
    try {
      return call(credential, 'toJSON')
    } catch {
      // Some password-manager extensions hand back a credential whose `toJSON` throws.
    }
  }
  return credentialToJson(credential)
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
}

function isRegistration(value: unknown): value is PasskeyRegistrationCredential {
  return (
    isRecord(value) &&
    isBase64Url(value.id) &&
    value.type === 'public-key' &&
    isRecord(value.response) &&
    isBase64Url(value.response.clientDataJSON) &&
    isBase64Url(value.response.attestationObject)
  )
}

function isAssertion(value: unknown): value is PasskeyAssertionCredential {
  return (
    isRecord(value) &&
    isBase64Url(value.id) &&
    value.type === 'public-key' &&
    isRecord(value.response) &&
    isBase64Url(value.response.clientDataJSON) &&
    isBase64Url(value.response.authenticatorData) &&
    isBase64Url(value.response.signature)
  )
}

/** The client code for what a ceremony threw. The browser's message is never passed on. */
function ceremonyCode(error: unknown) {
  const name = isRecord(error) || error instanceof Error ? (error as { name?: unknown }).name : ''
  if (name === 'InvalidStateError') {
    // `excludeCredentials` matched: this authenticator already holds a passkey of the account.
    return 'passkey.already_on_device' as const
  }
  if (name === 'NotSupportedError') {
    return 'passkey.unsupported' as const
  }
  // NotAllowedError is everything a user can do to end a ceremony (dismiss it, let it time
  // out, fail verification) and AbortError is the caller's own signal.
  return name === 'NotAllowedError' || name === 'AbortError'
    ? ('passkey.cancelled' as const)
    : ('passkey.failed' as const)
}

/**
 * The WebAuthn ceremonies of a browser, or `undefined` where there is no WebAuthn (a server, an
 * old browser, a page that is not a secure context).
 *
 * @param globals - Where `navigator` and `PublicKeyCredential` are looked up.
 * @param messages - The current locale table, for the errors.
 * @returns The ceremonies.
 */
export function browserAuthenticator(
  globals: PasskeyGlobals,
  messages: () => Messages
): PasskeyAuthenticator | undefined {
  let credentials: NonNullable<PasskeyGlobals['navigator']>['credentials']
  let PublicKey: PasskeyGlobals['PublicKeyCredential']
  try {
    credentials = globals.navigator?.credentials
    PublicKey = globals.PublicKeyCredential
  } catch {
    return undefined
  }
  if (!credentials?.create || !credentials.get || !PublicKey) {
    return undefined
  }
  const { create, get } = credentials
  const Platform = PublicKey

  async function ceremony<T>(
    run: () => Promise<unknown>,
    guard: (value: unknown) => value is T
  ): Promise<T> {
    let answer: unknown
    try {
      answer = toJson(await run())
    } catch (error) {
      throw clientError(ceremonyCode(error), messages())
    }
    if (!guard(answer)) {
      throw clientError('passkey.failed', messages())
    }
    return answer
  }

  return {
    async autofillAvailable() {
      try {
        return (await Platform.isConditionalMediationAvailable?.()) === true
      } catch {
        return false
      }
    },
    create: (options, request = {}) =>
      ceremony(
        () =>
          create.call(credentials, {
            publicKey:
              Platform.parseCreationOptionsFromJSON?.(options) ?? creationOptionsFromJson(options),
            ...(request.signal && { signal: request.signal }),
          }),
        isRegistration
      ),
    get: (options, request = {}) =>
      ceremony(
        () =>
          get.call(credentials, {
            publicKey:
              Platform.parseRequestOptionsFromJSON?.(options) ?? requestOptionsFromJson(options),
            ...(request.signal && { signal: request.signal }),
            ...(request.autofill && { mediation: 'conditional' }),
          }),
        isAssertion
      ),
  }
}

// Guards for the answers of the passkey routes: a 200 is not proof of talking to the API.

function isPasskey(value: unknown): value is Schemas['Passkey'] {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    typeof value.synced === 'boolean' &&
    typeof value.createdAt === 'string' &&
    (value.lastUsedAt === null || typeof value.lastUsedAt === 'string')
  )
}

/** A passkey as the client hands it on: the known fields and nothing else. */
export function toPasskey(value: Schemas['Passkey']): Schemas['Passkey'] {
  const { id, name, synced, createdAt, lastUsedAt } = value
  return { id, name, synced, createdAt, lastUsedAt }
}

export function isPasskeyAnswer(value: unknown): value is Schemas['Passkey'] {
  return isPasskey(value)
}

export function isPasskeyList(value: unknown): value is Schemas['PasskeyList'] {
  return isRecord(value) && Array.isArray(value.passkeys) && value.passkeys.every(isPasskey)
}

export function isCreationOptions(value: unknown): value is PasskeyCreationOptions {
  return (
    isRecord(value) &&
    isBase64Url(value.challenge) &&
    isRecord(value.rp) &&
    typeof value.rp.id === 'string' &&
    isRecord(value.user) &&
    isBase64Url(value.user.id) &&
    Array.isArray(value.pubKeyCredParams)
  )
}

export function isRequestOptions(value: unknown): value is PasskeyRequestOptions {
  return isRecord(value) && isBase64Url(value.challenge) && typeof value.rpId === 'string'
}

export function isPasskeySignInStart(value: unknown): value is Schemas['PasskeySignInStart'] {
  return isRecord(value) && isRecord(value.attempt) && isRequestOptions(value.options)
}
