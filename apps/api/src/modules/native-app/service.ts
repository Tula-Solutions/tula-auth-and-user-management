import {
  AndroidAppIdentitySchema,
  type AppleAppSiteAssociation,
  type AssetLinks,
  appleAppSiteAssociation as buildAppleAppSiteAssociation,
  assetLinks as buildAssetLinks,
  type CreateNativeAppRequest,
  IosAppIdentitySchema,
  MAX_NATIVE_APPS,
  NATIVE_APP_FIELDS,
  type NativeApp,
  type NativeAppIdentity,
  nativeAppIdentifier,
  nativeAppWeakenings,
  normalizeCertFingerprints,
  type UpdateNativeAppRequest,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { ConflictError, NotFoundError, ValidationError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import type { NativeAppChanges, NativeAppRecord } from '~/ports/native-app-store'

/**
 * `Cache-Control: max-age` of the two association files, in seconds. Short on purpose: an app
 * that was removed, or a fingerprint that was taken away, should stop being named soon, and
 * the platforms keep their own copies for much longer whatever is said here (ADR 0040).
 */
export const ASSOCIATION_MAX_AGE_SECONDS = 300

/** A stored app as the identity the files and the weakening rule are built from. */
function identity(record: NativeAppRecord): NativeAppIdentity {
  return record.platform === 'ios'
    ? // An iOS row always has a team: the table's own check says so.
      { platform: 'ios', teamId: record.teamId ?? '', bundleId: record.identifier }
    : {
        platform: 'android',
        packageName: record.identifier,
        sha256CertFingerprints: record.sha256CertFingerprints,
      }
}

/** The public view of a stored app. */
function view(record: NativeAppRecord): NativeApp {
  return {
    id: record.id,
    ...identity(record),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  } as NativeApp
}

/** The stored app, or the 404 every route answers for one that is not this environment's. */
async function requireApp(
  deps: Pick<Deps, 'nativeApps'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<NativeAppRecord> {
  const record = await deps.nativeApps.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/**
 * List the environment's native apps.
 *
 * @param deps - The app store.
 * @param tenant - The environment.
 * @returns The apps, oldest first.
 */
export async function list(
  deps: Pick<Deps, 'nativeApps'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<NativeApp[]> {
  return (await deps.nativeApps.list(tenant.environmentId)).map(view)
}

/**
 * Read one native app.
 *
 * @param deps - The app store.
 * @param tenant - The environment.
 * @param id - The app.
 * @returns The app.
 * @throws NotFoundError when the environment has no app with that id.
 */
export async function get(
  deps: Pick<Deps, 'nativeApps'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<NativeApp> {
  return view(await requireApp(deps, tenant, id))
}

/**
 * Register a native app for the environment.
 *
 * From then on the association files served for the environment name it, which is what makes
 * a platform believe the app is the environment's own: the registration is recorded as a
 * weakening. Fingerprints are stored upper case with colons, sorted, each once.
 *
 * @param deps - The app store, the environment's lock, ids and clock.
 * @param tenant - The environment to register it in.
 * @param input - The app's identity.
 * @param actor - Who registers it, for the audit log.
 * @returns The app.
 * @throws ConflictError when the environment already has that app, or already has
 *   `MAX_NATIVE_APPS` apps (`params.max`).
 * @throws ServiceUnavailableError when the environment's lock could not be had in time.
 */
export async function create(
  deps: Pick<Deps, 'nativeApps' | 'environmentLock' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateNativeAppRequest,
  actor: Actor
): Promise<NativeApp> {
  // The count and the insert take turns per environment, across instances: registrations
  // that arrive together cannot each see room for one more.
  return deps.environmentLock.runExclusive(tenant.environmentId, 'native_apps', () =>
    register(deps, tenant, input, actor)
  )
}

/** Count the environment's apps and add one. Called with the environment's lock held. */
async function register(
  deps: Pick<Deps, 'nativeApps' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateNativeAppRequest,
  actor: Actor
): Promise<NativeApp> {
  const existing = await deps.nativeApps.list(tenant.environmentId)
  if (existing.length >= MAX_NATIVE_APPS) {
    throw new ConflictError({
      message: `This environment already has ${MAX_NATIVE_APPS} native apps. Remove one first.`,
      params: { max: MAX_NATIVE_APPS },
    })
  }
  const id = deps.ids.next()
  const fingerprints =
    input.platform === 'android' ? normalizeCertFingerprints(input.sha256CertFingerprints) : []
  const activity = Audit.entry(deps, tenant, {
    type: 'native_app.created',
    actor,
    target: { type: 'native_app', id },
    data: { platform: input.platform, fingerprints: fingerprints.length, weakened: true },
  })
  const record = await deps.nativeApps.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      platform: input.platform,
      identifier: nativeAppIdentifier(input),
      teamId: input.platform === 'ios' ? input.teamId : null,
      sha256CertFingerprints: fingerprints,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  if (!record) {
    throw new ConflictError({
      message: 'This environment already has that app. Change it, or remove it first.',
    })
  }
  return view(record)
}

/** The 422 for a field that is not one of the app's platform. */
function notOfPlatform(field: (typeof NATIVE_APP_FIELDS)[number], platform: string) {
  const message =
    platform === 'ios'
      ? 'An iOS app has no fingerprints. Change its teamId.'
      : 'An Android app has no team. Change its sha256CertFingerprints.'
  return new ValidationError({ errors: [{ field, code: 'validation.failed', message }] })
}

/**
 * Change an iOS app's team or an Android app's fingerprints.
 *
 * The fingerprints given replace the stored set. The audit entry names the fields that
 * changed and never their values, and says `weakened` when the change widened what the files
 * say (another team, a fingerprint more: `nativeAppWeakenings`). A request that changes
 * nothing writes nothing. What an app is (its platform, its bundle id or package name)
 * cannot be changed: that is another app.
 *
 * The write is made only over the app as it was read, so the record of a weakening is about
 * the change made.
 *
 * @param deps - The app store, ids and clock.
 * @param tenant - The environment.
 * @param id - The app.
 * @param input - The field to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The app as it is now.
 * @throws NotFoundError when the environment has no app with that id.
 * @throws ValidationError when the field is not one of the app's platform.
 * @throws ConflictError when the app changed between the read and the write.
 */
export async function update(
  deps: Pick<Deps, 'nativeApps' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: UpdateNativeAppRequest,
  actor: Actor
): Promise<NativeApp> {
  const current = await requireApp(deps, tenant, id)
  if (current.platform === 'ios' && input.sha256CertFingerprints !== undefined) {
    throw notOfPlatform('sha256CertFingerprints', current.platform)
  }
  if (current.platform === 'android' && input.teamId !== undefined) {
    throw notOfPlatform('teamId', current.platform)
  }
  const changes: NativeAppChanges = {}
  if (input.teamId !== undefined && input.teamId !== current.teamId) {
    changes.teamId = input.teamId
  }
  if (input.sha256CertFingerprints !== undefined) {
    const next = normalizeCertFingerprints(input.sha256CertFingerprints)
    if (next.join() !== current.sha256CertFingerprints.join()) {
      changes.sha256CertFingerprints = next
    }
  }
  const changed = NATIVE_APP_FIELDS.filter((field) => changes[field] !== undefined)
  if (changed.length === 0) {
    return view(current)
  }
  const next: NativeAppRecord = { ...current, ...changes }
  const weakened = nativeAppWeakenings(identity(current), identity(next)).length > 0
  const updated = await deps.nativeApps.update(
    tenant.environmentId,
    id,
    current,
    changes,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'native_app.updated',
      actor,
      target: { type: 'native_app', id },
      data: {
        platform: current.platform,
        changed,
        fingerprints: next.sha256CertFingerprints.length,
        ...(weakened && { weakened }),
      },
    })
  )
  if (!updated) {
    // The guarded write matched nothing: the app was removed, or changed since it was read.
    throw (await deps.nativeApps.find(tenant.environmentId, id))
      ? new ConflictError({
          message: 'The app changed since it was read. Read it again and retry.',
        })
      : new NotFoundError()
  }
  return view(updated)
}

/**
 * Remove a native app. The association files stop naming it; the platforms keep the copies
 * they already fetched for as long as they choose to.
 *
 * @param deps - The app store, ids and clock.
 * @param tenant - The environment.
 * @param id - The app.
 * @param actor - Who removes it, for the audit log.
 * @throws NotFoundError when the environment has no app with that id.
 */
export async function remove(
  deps: Pick<Deps, 'nativeApps' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  const current = await requireApp(deps, tenant, id)
  const deleted = await deps.nativeApps.delete(
    tenant.environmentId,
    id,
    Audit.entry(deps, tenant, {
      type: 'native_app.deleted',
      actor,
      target: { type: 'native_app', id },
      data: { platform: current.platform },
    })
  )
  if (!deleted) {
    // Removed between the read and the write.
    throw new NotFoundError()
  }
}

/**
 * The stored apps of an environment named in a public path.
 *
 * **The environment comes from the path and from nowhere else**: not a header, not the
 * request's host, not a key. An environment that does not exist is a 404, as for its JWKS.
 */
async function appsOf(
  deps: Pick<Deps, 'nativeApps' | 'environments'>,
  environmentId: string
): Promise<NativeAppRecord[]> {
  if (!(await deps.environments.findById(environmentId))) {
    throw new NotFoundError()
  }
  return deps.nativeApps.list(environmentId)
}

/**
 * The two association files of an environment, built from its stored apps: the one place a
 * stored row becomes part of a file. The public routes serve exactly this, and the
 * diagnostics compare it with the rows it was built from (ADR 0040, "What `tula doctor`
 * checks").
 *
 * @param records - Every app of one environment, as stored.
 * @returns Apple's document and Android's statements.
 */
export function associationFiles(records: readonly NativeAppRecord[]): {
  apple: AppleAppSiteAssociation
  android: AssetLinks
} {
  const identities = records.map(identity)
  return {
    apple: buildAppleAppSiteAssociation(identities),
    android: buildAssetLinks(identities),
  }
}

/**
 * Whether a stored app is one this version would register: its identifiers pass the
 * contract's own schemas (the ones a registration is validated with, never a second copy of
 * a pattern), it has only the fields of its platform, and an Android app's fingerprints are
 * in the stored form, sorted, each once.
 *
 * A row is validated on the way in and by the table's checks, so `false` means a row written
 * by another version or by hand. Nothing of the row is returned: the diagnostics count.
 *
 * @param record - An app as stored.
 * @returns `true` when a registration of the same values would be accepted and stored so.
 */
export function wellFormed(record: NativeAppRecord): boolean {
  if (record.platform === 'ios') {
    return (
      record.sha256CertFingerprints.length === 0 &&
      IosAppIdentitySchema.safeParse({
        platform: 'ios',
        teamId: record.teamId,
        bundleId: record.identifier,
      }).success
    )
  }
  if (record.platform !== 'android') {
    // A platform this version does not know: it cannot say the app is well formed.
    return false
  }
  const fingerprints = record.sha256CertFingerprints
  return (
    record.teamId === null &&
    AndroidAppIdentitySchema.safeParse({
      platform: 'android',
      packageName: record.identifier,
      sha256CertFingerprints: fingerprints,
    }).success &&
    normalizeCertFingerprints(fingerprints).join() === fingerprints.join()
  )
}

/**
 * Apple's `apple-app-site-association` for an environment: its registered iOS apps under
 * `webcredentials`, and nothing else.
 *
 * @param deps - The app store and the environments.
 * @param environmentId - The environment, from the path.
 * @returns The document; `{}` when no iOS app is registered.
 * @throws NotFoundError when there is no such environment.
 */
export async function appleAppSiteAssociation(
  deps: Pick<Deps, 'nativeApps' | 'environments'>,
  environmentId: string
): Promise<AppleAppSiteAssociation> {
  return associationFiles(await appsOf(deps, environmentId)).apple
}

/**
 * Android's `assetlinks.json` for an environment: one statement per registered Android app.
 *
 * @param deps - The app store and the environments.
 * @param environmentId - The environment, from the path.
 * @returns The statements; `[]` when no Android app is registered.
 * @throws NotFoundError when there is no such environment.
 */
export async function assetLinks(
  deps: Pick<Deps, 'nativeApps' | 'environments'>,
  environmentId: string
): Promise<AssetLinks> {
  return associationFiles(await appsOf(deps, environmentId)).android
}
