import { z } from 'zod'
import { FlowAttemptSchema } from './flow'

/** The OAuth providers an environment can configure with its own credentials (ADR 0026). */
export const OAUTH_PROVIDERS = ['google', 'github', 'apple', 'microsoft'] as const

/** One of {@link OAUTH_PROVIDERS}. */
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS).meta({ ref: 'OAuthProvider' })

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
 * - Google and GitHub: `clientId` and `clientSecret`.
 * - Apple: `clientId` (the Services ID), `teamId`, `keyId` and `privateKey` (the `.p8` file's
 *   contents, PKCS#8 PEM).
 * - Microsoft: `clientId` (the application id), `clientSecret` and `tenant`
 *   ({@link MicrosoftTenantSchema}: which accounts may sign in).
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
