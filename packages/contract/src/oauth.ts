import { z } from 'zod'
import { FlowAttemptSchema } from './flow'

/** The OAuth providers an environment can configure with its own credentials (ADR 0026). */
export const OAUTH_PROVIDERS = [
  'google',
  'github',
  'apple',
  'microsoft',
  'discord',
  'linkedin',
  'x',
  'facebook',
] as const

/** One of {@link OAUTH_PROVIDERS}. */
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS).meta({ ref: 'OAuthProvider' })

/**
 * The providers Tula takes **no email address** from, as a fact about the provider and not a
 * setting: X and Facebook (ADR 0026, "Providers without an address").
 *
 * Neither asserts an address verified in a way a sign-in can rest on, so their adapters ask
 * for none and report none. A first sign-in with one creates an account **with no email
 * address**, and such an identity is never connected to an existing account by an address.
 * Every other provider is the opposite: no address, no account (`oauth.email_missing`).
 *
 * A closed list in the contract, read by the server's account resolution and by the screens
 * that tell an operator what enabling the provider means. Nothing a request or an
 * environment's settings say moves a provider in or out of it.
 *
 * @example
 * ```ts
 * OAUTH_PROVIDERS_WITHOUT_ADDRESS.includes('x') // true
 * ```
 */
export const OAUTH_PROVIDERS_WITHOUT_ADDRESS = [
  'x',
  'facebook',
] as const satisfies readonly (typeof OAUTH_PROVIDERS)[number][]

/**
 * Whether a provider is one Tula takes no email address from
 * ({@link OAUTH_PROVIDERS_WITHOUT_ADDRESS}).
 *
 * @param provider - A provider's name.
 * @returns `true` for X and Facebook.
 *
 * @example
 * ```ts
 * givesNoAddress('facebook') // true
 * givesNoAddress('google') // false
 * ```
 */
export function givesNoAddress(provider: string): boolean {
  return (OAUTH_PROVIDERS_WITHOUT_ADDRESS as readonly string[]).includes(provider)
}

/**
 * The authorities of the Microsoft identity platform that are not one organization: any
 * Microsoft account (`common`), any work or school account (`organizations`), personal
 * accounts only (`consumers`).
 */
export const MICROSOFT_TENANT_ALIASES = ['common', 'organizations', 'consumers'] as const

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Which Microsoft accounts may sign in: one of {@link MICROSOFT_TENANT_ALIASES}, or the id (a
 * GUID, lower-cased) of the one organization whose accounts are accepted. Not a secret.
 *
 * A domain name (`contoso.onmicrosoft.com`) is refused on purpose: a sign-in is checked
 * against the tenant id in the token, and only an id can be compared with it.
 *
 * @example
 * ```ts
 * MicrosoftTenantSchema.parse('common') // 'common'
 * MicrosoftTenantSchema.parse('72F988BF-86F1-41AF-91AB-2D7CD011DB47') // lower-cased
 * ```
 */
export const MicrosoftTenantSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) => (MICROSOFT_TENANT_ALIASES as readonly string[]).includes(value) || GUID.test(value),
    { message: 'must be common, organizations, consumers or a tenant id (a GUID)' }
  )
  .meta({ ref: 'MicrosoftTenant' })

/**
 * The providers whose **ID token** a native app may hand to the server for a sign-in, with no
 * browser redirect (ADR 0045): the app shows the system's own account sheet, the provider
 * gives the app an ID token, and the server verifies it.
 *
 * A closed list in the contract, as a fact about what the server can verify and not a
 * setting: a provider is here only when its adapter verifies an ID token's signature,
 * issuer, expiry, audience and nonce.
 *
 * @example
 * ```ts
 * ID_TOKEN_PROVIDERS.includes('google') // true
 * ```
 */
export const ID_TOKEN_PROVIDERS = [
  'google',
] as const satisfies readonly (typeof OAUTH_PROVIDERS)[number][]

/** One of {@link ID_TOKEN_PROVIDERS}. */
export const IdTokenProviderSchema = z.enum(ID_TOKEN_PROVIDERS).meta({ ref: 'IdTokenProvider' })

/**
 * The most client ids a provider accepts ID tokens for beside its own `clientId`
 * (`additionalClientIds`). An app has an Android and an iOS client, sometimes one more per
 * build flavour; a longer list is a list nobody reviews.
 */
export const MAX_ADDITIONAL_CLIENT_IDS = 8

// A project number, usually a hyphen and an opaque part, and Google's suffix. One spelling:
// lower case, nothing around it.
const GOOGLE_CLIENT_ID = /^[0-9]{1,32}(-[0-9a-z]{1,64})?\.apps\.googleusercontent\.com$/

/**
 * Whether a string has the shape of a Google OAuth client id
 * (`<project number>-<opaque>.apps.googleusercontent.com`). Says nothing about whether
 * Google has issued it.
 *
 * @param value - The candidate.
 * @returns `true` for the one spelling of a client id.
 *
 * @example
 * ```ts
 * isGoogleClientId('1234567890-abc123def456.apps.googleusercontent.com') // true
 * isGoogleClientId('com.example.app') // false
 * ```
 */
export function isGoogleClientId(value: string): boolean {
  return value.length <= 128 && GOOGLE_CLIENT_ID.test(value)
}

/**
 * The client ids, beside a provider's own `clientId`, whose **ID tokens** the server accepts
 * in a native sign-in (ADR 0045): for Google, the Android and iOS OAuth client ids of the
 * operator's apps. Not secrets. A set: an id is written once, and the order says nothing.
 *
 * Each entry widens who can mint a token the server takes as a sign-in, which is why it is
 * validated by shape here, capped at {@link MAX_ADDITIONAL_CLIENT_IDS}, and why adding one
 * is a recorded weakening ({@link oauthProviderWeakenings}).
 *
 * @example
 * ```ts
 * AdditionalClientIdsSchema.parse(['1234567890-abc123.apps.googleusercontent.com'])
 * ```
 */
export const AdditionalClientIdsSchema = z
  .array(
    z.string().refine(isGoogleClientId, {
      message: 'must be a Google OAuth client id (…apps.googleusercontent.com)',
    })
  )
  .max(MAX_ADDITIONAL_CLIENT_IDS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'must not repeat a client id' })
  .meta({ ref: 'AdditionalClientIds' })

/**
 * Where a list of additional client ids names the provider's **own** `clientId`, which is
 * not an additional one: tokens for it are accepted already, and listed again it would be
 * counted, shown and asked about as another app.
 *
 * The one statement of the rule, for the admin API (a validation error on the entry),
 * `@tula/config` (the file is refused) and the dashboard (said at the field before a save).
 * Compared exactly, as every client id is.
 *
 * @param clientId - The provider's own client id.
 * @param additionalClientIds - The list beside it.
 * @returns The position of the first entry equal to `clientId`, or `-1`.
 *
 * @example
 * ```ts
 * ownClientIdAmong('1-web.apps.googleusercontent.com', ['1-ios.apps.googleusercontent.com']) // -1
 * ```
 */
export function ownClientIdAmong(clientId: string, additionalClientIds: readonly string[]): number {
  return additionalClientIds.indexOf(clientId)
}

/**
 * What of a provider's record decides whose ID tokens are accepted, for
 * {@link oauthProviderWeakenings}.
 */
export interface OAuthProviderAudiences {
  /** The client ids accepted beside the provider's own. Absent means none. */
  additionalClientIds?: readonly string[]
}

/**
 * The paths at which a change to a provider's record accepts more than it did: today, one
 * thing, a client id gained in `additionalClientIds`.
 *
 * Every accepted client id is another app whose ID tokens sign users in, so a new one is a
 * weakening in the sense of the settings' (`settingsWeakenings`): the audit entry says
 * `weakened: true`, the dashboard says so before it saves, and `tula apply --yes` refuses it
 * without `--allow-weaker`. An id taken away, and a reordering, are not. The path names the
 * field and never a client id.
 *
 * @param before - The record as stored, or `null` when the provider was not configured.
 * @param after - The record as it will be stored.
 * @returns `['additionalClientIds']`, or an empty list.
 *
 * @example
 * ```ts
 * oauthProviderWeakenings({ additionalClientIds: [] }, { additionalClientIds: [id] })
 * // ['additionalClientIds']
 * ```
 */
export function oauthProviderWeakenings(
  before: OAuthProviderAudiences | null,
  after: OAuthProviderAudiences
): string[] {
  const had = new Set(before?.additionalClientIds ?? [])
  return (after.additionalClientIds ?? []).some((id) => !had.has(id)) ? ['additionalClientIds'] : []
}

/** Longest ID token a request may carry. Google's are under two thousand characters. */
export const MAX_ID_TOKEN_LENGTH = 8192

/**
 * Start a native sign-in with a provider's ID token (ADR 0045). The body names the provider
 * and nothing else: there is no redirect URL, because there is no browser.
 */
export const IdTokenStartRequestSchema = z
  .strictObject({ provider: IdTokenProviderSchema })
  .meta({ ref: 'IdTokenStartRequest' })

/**
 * The answer to starting a native ID-token sign-in.
 *
 * - `attempt`: the attempt, waiting on `needs_first_factor` with the provider's strategy.
 * - `nonce`: made by the server, returned **once**. The app hands it, unchanged, to the
 *   provider's SDK as the nonce of the sign-in request; the ID token that comes back must
 *   carry exactly this value in its `nonce` claim. It is not a secret and authorizes nothing.
 */
export const IdTokenStartSchema = z
  .object({ attempt: FlowAttemptSchema, nonce: z.string() })
  .meta({ ref: 'IdTokenStart' })

/** What a native app sends to finish the sign-in: the provider's ID token, and nothing else. */
export const IdTokenExchangeRequestSchema = z
  .strictObject({ idToken: z.string().min(1).max(MAX_ID_TOKEN_LENGTH) })
  .meta({ ref: 'IdTokenExchangeRequest' })

/** Longest redirect URL, ticket or binding a request may carry. */
const MAX_OAUTH_FIELD_LENGTH = 2048

/**
 * Start "continue with a provider": a sign-in that creates the account when there is none.
 *
 * `redirectUrl` is the page of the app the user comes back to. It must be, exactly, one of the
 * environment's `urls.allowedRedirectUrls`.
 */
export const OAuthStartRequestSchema = z
  .object({
    provider: OAuthProviderSchema,
    redirectUrl: z.string().max(MAX_OAUTH_FIELD_LENGTH),
  })
  .meta({ ref: 'OAuthStartRequest' })

/**
 * The answer to starting an OAuth sign-in.
 *
 * - `authorizationUrl`: where to send the browser (the provider's consent page).
 * - `binding`: a random value, returned **once**, that ties the provider's answer to the browser
 *   that asked. Keep it for the tab (`sessionStorage`; it is not a token and authorizes nothing
 *   alone) and send it back with the ticket the app's page receives.
 * - `attempt`: the attempt, waiting on `needs_first_factor` with the provider's strategy.
 */
export const OAuthStartSchema = z
  .object({
    attempt: FlowAttemptSchema,
    authorizationUrl: z.url(),
    binding: z.string(),
  })
  .meta({ ref: 'OAuthStart' })

/**
 * What the app's page sends after the provider returned: the ticket and attempt id from the
 * URL fragment, and the binding this browser was given at the start.
 */
export const OAuthExchangeRequestSchema = z
  .object({
    ticket: z.string().min(1).max(MAX_OAUTH_FIELD_LENGTH),
    attemptId: z.uuid(),
    /** Absent in a browser that did not start the sign-in; such a request completes nothing. */
    binding: z.string().max(MAX_OAUTH_FIELD_LENGTH).optional(),
  })
  .meta({ ref: 'OAuthExchangeRequest' })

/**
 * A provider account connected to a user. Never the provider's own id for the account, and no
 * provider token: Tula stores none.
 */
export const IdentitySchema = z
  .object({
    id: z.string(),
    /** One of {@link OAUTH_PROVIDERS} today; a plain string so later providers do not break a client. */
    provider: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'Identity' })

/** The provider accounts connected to the signed-in user. */
export const IdentityListSchema = z
  .object({ data: z.array(IdentitySchema) })
  .meta({ ref: 'IdentityList' })

/** The answer to starting to connect a provider account from a profile. */
export const IdentityLinkStartSchema = z
  .object({
    attemptId: z.string(),
    expiresAt: z.iso.datetime(),
    authorizationUrl: z.url(),
    binding: z.string(),
  })
  .meta({ ref: 'IdentityLinkStart' })

/**
 * One provider as an administrator sees it. Never the secret.
 *
 * `callbackUrl` is the redirect URI to paste into the provider's console, exactly.
 */
export const OAuthProviderSettingsSchema = z
  .object({
    provider: OAuthProviderSchema,
    /** Whether credentials are stored for it. */
    configured: z.boolean(),
    /** Whether sign-in offers it. Always `false` when not configured. */
    enabled: z.boolean(),
    clientId: z.string().nullable(),
    /** Apple only: the developer team id. */
    teamId: z.string().nullable(),
    /** Apple only: the id of the signing key. */
    keyId: z.string().nullable(),
    /**
     * Microsoft only: which accounts may sign in (`common`, `organizations`, `consumers` or a
     * tenant id). `null` for every other provider and while Microsoft is not configured.
     */
    tenant: z.string().nullable(),
    /**
     * The client ids accepted beside `clientId` for a native sign-in's ID tokens
     * ({@link AdditionalClientIdsSchema}), sorted. Empty for a provider that takes none and
     * while the provider is not configured. An answer without the field (a server from
     * before it) is read as none.
     */
    additionalClientIds: z.array(z.string()).default([]),
    callbackUrl: z.url(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ ref: 'OAuthProviderSettings' })

/** Every provider, configured or not. */
export const OAuthProviderSettingsListSchema = z
  .object({ data: z.array(OAuthProviderSettingsSchema) })
  .meta({ ref: 'OAuthProviderSettingsList' })

const credential = (max: number) => z.string().trim().min(1).max(max)

/**
 * Set a provider's credentials and whether sign-in offers it.
 *
 * - Google, GitHub, Discord, LinkedIn, X and Facebook: `clientId` and `clientSecret`.
 * - Apple: `clientId` (the Services ID), `teamId`, `keyId` and `privateKey` (the `.p8` file's
 *   contents, PKCS#8 PEM).
 * - Microsoft: `clientId` (the application id), `clientSecret` and `tenant`
 *   ({@link MicrosoftTenantSchema}: which accounts may sign in).
 *
 * Google also takes `additionalClientIds`: the client ids of the operator's Android and iOS
 * apps, whose ID tokens a native sign-in accepts beside `clientId`'s (ADR 0045). Left out,
 * there are none: the field is the whole set on every write, never merged.
 *
 * The secret (`clientSecret` or `privateKey`) may be left out when the provider is already
 * configured: the stored one is kept. It is stored sealed and never returned.
 */
export const OAuthProviderUpdateSchema = z
  .strictObject({
    clientId: credential(512),
    clientSecret: credential(2048).optional(),
    teamId: credential(64).optional(),
    keyId: credential(64).optional(),
    privateKey: credential(8192).optional(),
    tenant: MicrosoftTenantSchema.optional(),
    additionalClientIds: AdditionalClientIdsSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .meta({ ref: 'OAuthProviderUpdate' })

/** An OAuth provider. */
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>
/** Which Microsoft accounts may sign in. */
export type MicrosoftTenant = z.infer<typeof MicrosoftTenantSchema>
/** OAuth start request body. */
export type OAuthStartRequest = z.infer<typeof OAuthStartRequestSchema>
/** OAuth start response. */
export type OAuthStart = z.infer<typeof OAuthStartSchema>
/** A provider whose ID token a native app may exchange. */
export type IdTokenProvider = z.infer<typeof IdTokenProviderSchema>
/** Native ID-token sign-in start request body. */
export type IdTokenStartRequest = z.infer<typeof IdTokenStartRequestSchema>
/** Native ID-token sign-in start response. */
export type IdTokenStart = z.infer<typeof IdTokenStartSchema>
/** Native ID-token exchange request body. */
export type IdTokenExchangeRequest = z.infer<typeof IdTokenExchangeRequestSchema>
/** OAuth exchange request body. */
export type OAuthExchangeRequest = z.infer<typeof OAuthExchangeRequestSchema>
/** A connected provider account. */
export type Identity = z.infer<typeof IdentitySchema>
/** The connected provider accounts. */
export type IdentityList = z.infer<typeof IdentityListSchema>
/** The answer to starting to connect a provider account. */
export type IdentityLinkStart = z.infer<typeof IdentityLinkStartSchema>
/** One provider's admin view. */
export type OAuthProviderSettings = z.infer<typeof OAuthProviderSettingsSchema>
/** Every provider's admin view. */
export type OAuthProviderSettingsList = z.infer<typeof OAuthProviderSettingsListSchema>
/** Admin request to set a provider's credentials. */
export type OAuthProviderUpdate = z.infer<typeof OAuthProviderUpdateSchema>
