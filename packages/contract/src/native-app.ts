import { z } from 'zod'

// A native app's identity (ADR 0040): what the platform, not the app, says an app is. An iOS
// app is its bundle id under an Apple team; an Android app is its package name and the
// SHA-256 fingerprints of the certificates it may be signed with. An environment registers
// the apps that are its own, and the server serves, from those rows and nothing else, the two
// files the platforms fetch to believe it: Apple's `apple-app-site-association` and Android's
// `assetlinks.json`.
//
// None of it is a secret: the files are public and name every registered app.

/**
 * The platforms an app can be registered for. A closed list.
 *
 * @example
 * ```ts
 * const platform: NativeAppPlatform = NATIVE_APP_PLATFORMS[0] // 'ios'
 * ```
 */
export const NATIVE_APP_PLATFORMS = ['ios', 'android'] as const

/** One of {@link NATIVE_APP_PLATFORMS}. */
export type NativeAppPlatform = (typeof NATIVE_APP_PLATFORMS)[number]

/**
 * How many native apps an environment can register, both platforms together. The served files
 * are public, fetched unauthenticated and built on every request: they stay small.
 *
 * @example
 * ```ts
 * apps.length <= MAX_NATIVE_APPS
 * ```
 */
export const MAX_NATIVE_APPS = 20

/**
 * How many signing-certificate fingerprints an Android app can have: a debug key, an upload
 * key, the store's signing key and a rotation of each fit several times over.
 *
 * @example
 * ```ts
 * app.sha256CertFingerprints.length <= MAX_CERT_FINGERPRINTS
 * ```
 */
export const MAX_CERT_FINGERPRINTS = 10

/**
 * Longest bundle id accepted. Apple's own limit is not stated here as a fact: this is a cap
 * that every bundle id the platform accepts is believed to fit (ADR 0040).
 *
 * @example
 * ```ts
 * bundleId.length <= MAX_BUNDLE_ID_LENGTH
 * ```
 */
export const MAX_BUNDLE_ID_LENGTH = 155

/**
 * Longest Android package name accepted.
 *
 * @example
 * ```ts
 * packageName.length <= MAX_PACKAGE_NAME_LENGTH
 * ```
 */
export const MAX_PACKAGE_NAME_LENGTH = 255

/**
 * An Apple team id: ten characters, upper-case letters and digits.
 *
 * @example
 * ```ts
 * APPLE_TEAM_ID_PATTERN.test('A1B2C3D4E5') // true
 * ```
 */
export const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/

/**
 * An iOS bundle id: two or more segments of letters, digits and hyphens, joined by periods
 * (reverse-DNS). Compared exactly, case included.
 *
 * @example
 * ```ts
 * BUNDLE_ID_PATTERN.test('com.example.app') // true
 * ```
 */
export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/

/**
 * An Android package name: two or more segments joined by periods, each starting with a
 * letter and holding letters, digits and underscores only.
 *
 * @example
 * ```ts
 * PACKAGE_NAME_PATTERN.test('com.example.app') // true
 * ```
 */
export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

/**
 * A SHA-256 certificate fingerprint as the server stores and serves it: 32 bytes as
 * upper-case hex pairs joined by colons, which is how `keytool` and the Play Console print
 * one and how `assetlinks.json` carries it.
 *
 * @example
 * ```ts
 * CERT_FINGERPRINT_PATTERN.test(fingerprint)
 * ```
 */
export const CERT_FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/

/** What is accepted for a fingerprint: the stored form in either case, or 64 hex digits. */
const CERT_FINGERPRINT_INPUT_PATTERN = /^(?:(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{64})$/

/**
 * A fingerprint in the form the server stores: upper case, a colon between bytes.
 *
 * Accepted on input are that form in either case and 64 hex digits with no separator (what
 * `apksigner` prints). Anything else is not a fingerprint and is not guessed at.
 *
 * @param input - A fingerprint as an operator pasted it.
 * @returns The stored form, or `null` when `input` is not a SHA-256 fingerprint.
 *
 * @example
 * ```ts
 * normalizeCertFingerprint('ab'.repeat(32)) // 'AB:AB:…:AB'
 * ```
 */
export function normalizeCertFingerprint(input: string): string | null {
  if (!CERT_FINGERPRINT_INPUT_PATTERN.test(input)) {
    return null
  }
  const hex = input.replaceAll(':', '').toUpperCase()
  return (hex.match(/.{2}/g) ?? []).join(':')
}

/**
 * A list of fingerprints as the set it is: each in the stored form, each once, sorted.
 *
 * @param fingerprints - Fingerprints the request schema accepted.
 * @returns The set, in a stable order. An entry that is no fingerprint is left out.
 *
 * @example
 * ```ts
 * normalizeCertFingerprints([lower, UPPER]) // one entry when they are the same bytes
 * ```
 */
export function normalizeCertFingerprints(fingerprints: readonly string[]): string[] {
  const set = new Set<string>()
  for (const fingerprint of fingerprints) {
    const normal = normalizeCertFingerprint(fingerprint)
    if (normal) {
      set.add(normal)
    }
  }
  return [...set].sort()
}

const teamId = () =>
  z
    .string()
    .regex(APPLE_TEAM_ID_PATTERN, 'Must be the ten upper-case letters and digits of an Apple team.')

const bundleId = () =>
  z
    .string()
    .max(MAX_BUNDLE_ID_LENGTH)
    .regex(
      BUNDLE_ID_PATTERN,
      'Must be a bundle id such as com.example.app: letters, digits and hyphens in segments joined by periods.'
    )

const packageName = () =>
  z
    .string()
    .max(MAX_PACKAGE_NAME_LENGTH)
    .regex(
      PACKAGE_NAME_PATTERN,
      'Must be a package name such as com.example.app: two or more segments joined by periods, each starting with a letter.'
    )

const fingerprints = () =>
  z
    .array(
      z
        .string()
        .max(95)
        .regex(
          CERT_FINGERPRINT_INPUT_PATTERN,
          'Must be a SHA-256 fingerprint: 32 bytes as hex, with or without colons.'
        )
    )
    .min(1)
    .max(MAX_CERT_FINGERPRINTS)
    .refine((list) => normalizeCertFingerprints(list).length === list.length, {
      message: 'Name each fingerprint once.',
    })

/**
 * The fields of a registered app an update can change, as `native_app.updated` names them.
 * The platform and the bundle id or package name are what the app **is** and cannot change.
 *
 * @example
 * ```ts
 * const changed: (typeof NATIVE_APP_FIELDS)[number][] = ['sha256CertFingerprints']
 * ```
 */
export const NATIVE_APP_FIELDS = ['teamId', 'sha256CertFingerprints'] as const

const stamps = { id: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }

/** A registered iOS app: a bundle id under an Apple team. */
export const IosAppSchema = z
  .object({
    ...stamps,
    platform: z.literal('ios'),
    /** The Apple team (the App ID prefix) the app is signed by. */
    teamId: z.string(),
    /** The app's bundle id. With the platform, what the app is in its environment. */
    bundleId: z.string(),
  })
  .meta({ ref: 'IosApp' })

/** A registered Android app: a package name and the certificates it may be signed with. */
export const AndroidAppSchema = z
  .object({
    ...stamps,
    platform: z.literal('android'),
    /** The app's package name. With the platform, what the app is in its environment. */
    packageName: z.string(),
    /** SHA-256 fingerprints of its signing certificates, in the stored form, sorted. A set. */
    sha256CertFingerprints: z.array(z.string()),
  })
  .meta({ ref: 'AndroidApp' })

/** A native app registered for an environment, as the admin API lists it. */
export const NativeAppSchema = z
  .discriminatedUnion('platform', [IosAppSchema, AndroidAppSchema])
  .meta({ ref: 'NativeApp' })

/** An environment's native apps, oldest first. */
export const NativeAppListSchema = z
  .object({ data: z.array(NativeAppSchema) })
  .meta({ ref: 'NativeAppList' })

/** The identity of an iOS app, as a registration and a config file write it. */
export const IosAppIdentitySchema = z
  .strictObject({ platform: z.literal('ios'), teamId: teamId(), bundleId: bundleId() })
  .meta({ ref: 'IosAppIdentity' })

/**
 * The identity of an Android app, as a registration and a config file write it. A fingerprint
 * is accepted as colon-separated hex in either case or as 64 hex digits, and stored upper
 * case with colons.
 */
export const AndroidAppIdentitySchema = z
  .strictObject({
    platform: z.literal('android'),
    packageName: packageName(),
    sha256CertFingerprints: fingerprints(),
  })
  .meta({ ref: 'AndroidAppIdentity' })

/**
 * Body of `POST /v1/admin/native-apps`: an iOS app (`teamId`, `bundleId`) or an Android app
 * (`packageName`, `sha256CertFingerprints`). An environment has one app per platform and
 * bundle id or package name.
 */
export const CreateNativeAppRequestSchema = z
  .discriminatedUnion('platform', [IosAppIdentitySchema, AndroidAppIdentitySchema])
  .meta({ ref: 'CreateNativeAppRequest' })

/**
 * Body of `PATCH /v1/admin/native-apps/{id}`: an iOS app's `teamId`, or an Android app's
 * `sha256CertFingerprints` (the whole set, replacing what is stored). Exactly the field of
 * the app's own platform; the other is refused.
 */
export const UpdateNativeAppRequestSchema = z
  .strictObject({
    teamId: teamId().optional(),
    sha256CertFingerprints: fingerprints().optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: 'Name at least one field to change.',
  })
  .meta({ ref: 'UpdateNativeAppRequest' })

/**
 * The Digital Asset Links relations an Android app is served with (ADR 0040).
 *
 * Today one: `get_login_creds`, which lets the app use the credentials (passkeys, saved
 * passwords) of the domain the file is served from. `handle_all_urls` (app links) is **not**
 * served: it would let the app open every link of the domain, and which links an app takes
 * is a decision of its own.
 *
 * @example
 * ```ts
 * ASSET_LINKS_RELATIONS.includes('delegate_permission/common.get_login_creds') // true
 * ```
 */
export const ASSET_LINKS_RELATIONS = ['delegate_permission/common.get_login_creds'] as const

/**
 * Apple's `apple-app-site-association` document, as served for an environment.
 *
 * It has the `webcredentials` section and no other: an app named there may use the
 * credentials (passkeys, saved passwords) of the domain. There is no `applinks` section, so
 * no app is handed a link of the domain. With no iOS app registered the document is `{}`:
 * a section that is absent grants nothing.
 */
export const AppleAppSiteAssociationSchema = z
  .strictObject({
    webcredentials: z
      .strictObject({
        /** App ids, `<team id>.<bundle id>`. */
        apps: z.array(z.string()).min(1),
      })
      .optional(),
  })
  .meta({ ref: 'AppleAppSiteAssociation' })

/**
 * Android's `assetlinks.json`, as served for an environment: one statement per registered
 * Android app, each with the relations of {@link ASSET_LINKS_RELATIONS}. With no Android app
 * registered it is `[]`.
 */
export const AssetLinksSchema = z
  .array(
    z.strictObject({
      relation: z.array(z.string()).min(1),
      target: z.strictObject({
        namespace: z.literal('android_app'),
        package_name: z.string(),
        sha256_cert_fingerprints: z.array(z.string()).min(1),
      }),
    })
  )
  .meta({ ref: 'AssetLinks' })

/** A registered iOS app. */
export type IosApp = z.infer<typeof IosAppSchema>
/** A registered Android app. */
export type AndroidApp = z.infer<typeof AndroidAppSchema>
/** A registered native app. */
export type NativeApp = z.infer<typeof NativeAppSchema>
/** An iOS app's identity. */
export type IosAppIdentity = z.infer<typeof IosAppIdentitySchema>
/** An Android app's identity. */
export type AndroidAppIdentity = z.infer<typeof AndroidAppIdentitySchema>
/** Body of an app's registration. */
export type CreateNativeAppRequest = z.infer<typeof CreateNativeAppRequestSchema>
/** Body of an app's update. */
export type UpdateNativeAppRequest = z.infer<typeof UpdateNativeAppRequestSchema>
/** The served `apple-app-site-association`. */
export type AppleAppSiteAssociation = z.infer<typeof AppleAppSiteAssociationSchema>
/** The served `assetlinks.json`. */
export type AssetLinks = z.infer<typeof AssetLinksSchema>

/** What of an app the served files are built from. */
export type NativeAppIdentity =
  | { platform: 'ios'; teamId: string; bundleId: string }
  | { platform: 'android'; packageName: string; sha256CertFingerprints: readonly string[] }

/**
 * What an app is within its environment and platform: the bundle id or the package name.
 *
 * @param app - A registered app, or the identity of one.
 * @returns The bundle id of an iOS app, the package name of an Android app.
 *
 * @example
 * ```ts
 * nativeAppIdentifier({ platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' })
 * // 'com.example.app'
 * ```
 */
export function nativeAppIdentifier(app: NativeAppIdentity): string {
  return app.platform === 'ios' ? app.bundleId : app.packageName
}

/**
 * Build the `apple-app-site-association` document from an environment's apps.
 *
 * Only the iOS apps are in it, each as `<team id>.<bundle id>`, sorted. Nothing else of an
 * app, and nothing that is not an app, goes into the file.
 *
 * @param apps - The environment's registered apps, of any platform.
 * @returns The document; `{}` when no iOS app is registered.
 *
 * @example
 * ```ts
 * appleAppSiteAssociation([{ platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' }])
 * // { webcredentials: { apps: ['A1B2C3D4E5.com.example.app'] } }
 * ```
 */
export function appleAppSiteAssociation(
  apps: readonly NativeAppIdentity[]
): AppleAppSiteAssociation {
  const ids = apps
    .filter((app) => app.platform === 'ios')
    .map((app) => `${app.teamId}.${app.bundleId}`)
    .sort()
  return ids.length > 0 ? { webcredentials: { apps: ids } } : {}
}

/**
 * Build the `assetlinks.json` document from an environment's apps.
 *
 * One statement per Android app, sorted by package name, each with the relations of
 * {@link ASSET_LINKS_RELATIONS} and the app's fingerprints.
 *
 * @param apps - The environment's registered apps, of any platform.
 * @returns The statements; `[]` when no Android app is registered.
 *
 * @example
 * ```ts
 * assetLinks([{ platform: 'android', packageName: 'com.example.app', sha256CertFingerprints }])
 * // [{ relation: ['delegate_permission/common.get_login_creds'], target: { … } }]
 * ```
 */
export function assetLinks(apps: readonly NativeAppIdentity[]): AssetLinks {
  return apps
    .filter((app) => app.platform === 'android')
    .sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0))
    .map((app) => ({
      relation: [...ASSET_LINKS_RELATIONS],
      target: {
        namespace: 'android_app' as const,
        package_name: app.packageName,
        sha256_cert_fingerprints: [...app.sha256CertFingerprints],
      },
    }))
}

/**
 * What of a change to an environment's native apps widens who the platforms will believe is
 * the environment's own app: the same idea as `settingsWeakenings` and `hookWeakenings`, and
 * for the same uses (the audit entry's `weakened`, `tula apply --yes`, the dashboard's
 * confirmation).
 *
 * - `app`: an app is registered. The served files name it from then on.
 * - `teamId`: an iOS app is moved to another team. The app the files name is another app.
 * - `sha256CertFingerprints`: an Android app gains a fingerprint. Whoever holds that
 *   certificate's key can sign the app.
 *
 * Removing an app, and removing a fingerprint, widen nothing and are not listed.
 *
 * @param was - The app before; `null` when it is being registered.
 * @param is - The app after; `null` when it is being removed.
 * @returns What was widened; empty when nothing was.
 *
 * @example
 * ```ts
 * nativeAppWeakenings(null, { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' })
 * // ['app']
 * ```
 */
export function nativeAppWeakenings(
  was: NativeAppIdentity | null,
  is: NativeAppIdentity | null
): ('app' | (typeof NATIVE_APP_FIELDS)[number])[] {
  if (!is) {
    return []
  }
  if (!was) {
    return ['app']
  }
  if (was.platform === 'ios' && is.platform === 'ios') {
    return was.teamId === is.teamId ? [] : ['teamId']
  }
  if (was.platform === 'android' && is.platform === 'android') {
    const before = new Set(normalizeCertFingerprints(was.sha256CertFingerprints))
    const gained = normalizeCertFingerprints(is.sha256CertFingerprints).some(
      (fingerprint) => !before.has(fingerprint)
    )
    return gained ? ['sha256CertFingerprints'] : []
  }
  // Another platform under the same row cannot happen; were it to, it is another app.
  return ['app']
}
