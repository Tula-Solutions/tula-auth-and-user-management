import {
  CreateNativeAppRequestSchema,
  MAX_NATIVE_APPS,
  normalizeCertFingerprints,
  UpdateNativeAppRequestSchema,
} from '@tula/contract'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import { invalid } from './fake-webhooks'

// The fake API's native app routes (`/v1/admin/native-apps`): the shapes, the refusals and
// the error codes of `apps/api/src/modules/native-app`, on plain in-memory data.
//
// What it keeps of the API: what is refused before anything is looked up (an id that is no
// UUID, a body the contract's strict schemas refuse: 422 `validation.failed`, with the
// field), one app per platform and identifier per environment and the cap (409
// `resource.conflict`, the cap with `params.max`), a field of the other platform (422 on
// that field), fingerprints stored as a sorted set in upper case with colons, and a change
// that changes nothing (nothing moves, `updatedAt` included).
//
// Where it differs, on purpose:
// - The compare-and-set of an update never misses (nothing changes an app between the read
//   and the write here). A test that needs that 409 overrides the route.
// - The two association files are not served: the dashboard shows their addresses and never
//   fetches them.
// - No rate limit, and an environment that does not exist is not a 404: an app is simply
//   not found under it.

const NOW = '2026-10-09T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'

const AppParams = z.object({ id: z.uuid() })

/** A native app as the fake holds it: the API's view, plus the environment it is in. */
export type FakeNativeApp = {
  id: string
  environmentId: string
  createdAt: string
  updatedAt: string
} & (
  | { platform: 'ios'; teamId: string; bundleId: string }
  | { platform: 'android'; packageName: string; sha256CertFingerprints: string[] }
)

/** The part of the fake's state the native app routes work on. */
export interface FakeNativeAppState {
  /** Every environment's native apps, oldest first. */
  nativeApps: FakeNativeApp[]
}

let made = 0

function nextId(): string {
  made += 1
  return `00000000-0000-7000-8000-e${String(made).padStart(11, '0')}`
}

/**
 * An iOS app for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs.
 * @returns The app.
 */
export function fakeIosApp(
  overrides: Partial<Extract<FakeNativeApp, { platform: 'ios' }>> = {}
): FakeNativeApp {
  return {
    id: nextId(),
    environmentId: IDS.development,
    platform: 'ios',
    teamId: 'A1B2C3D4E5',
    bundleId: 'app.northline.ios',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * An Android app for a test to put in the fake's state, in the development environment.
 *
 * @param overrides - What differs.
 * @returns The app.
 */
export function fakeAndroidApp(
  overrides: Partial<Extract<FakeNativeApp, { platform: 'android' }>> = {}
): FakeNativeApp {
  return {
    id: nextId(),
    environmentId: IDS.development,
    platform: 'android',
    packageName: 'app.northline.android',
    sha256CertFingerprints: [Array.from({ length: 32 }, () => 'AA').join(':')],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function view({ environmentId: _environmentId, ...app }: FakeNativeApp) {
  return app
}

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

function wrongPlatform(field: string, message: string): Response {
  return failure(422, 'validation.failed', 'The request is not valid.', [
    { field, code: 'validation.failed', message },
  ])
}

const identifierOf = (app: FakeNativeApp) =>
  app.platform === 'ios' ? app.bundleId : app.packageName

/**
 * The native app routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its native app part.
 * @returns The routes, in the fake's own table format.
 */
export function nativeAppRoutes(state: FakeNativeAppState): [string, RegExp, FakeHandler][] {
  const environmentOf = (call: FakeCall) => call.headers.get(ENVIRONMENT) ?? ''

  function onApp<Body>(
    body: z.ZodType<Body> | null,
    handler: (app: FakeNativeApp, body: Body) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      const params = AppParams.safeParse({ id: match[1] })
      if (!params.success) {
        return invalid(params.error)
      }
      const given = body === null ? null : body.safeParse(call.body ?? {})
      if (given && !given.success) {
        return invalid(given.error)
      }
      const app = state.nativeApps.find(
        (entry) => entry.id === params.data.id && entry.environmentId === environmentOf(call)
      )
      return app ? handler(app, given?.data as Body) : notFound()
    }
  }

  return [
    [
      'GET',
      /^\/v1\/admin\/native-apps$/,
      (call) => ({
        data: state.nativeApps
          .filter((entry) => entry.environmentId === environmentOf(call))
          .map(view),
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/native-apps$/,
      (call) => {
        const body = CreateNativeAppRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = environmentOf(call)
        const mine = state.nativeApps.filter((entry) => entry.environmentId === environmentId)
        if (mine.length >= MAX_NATIVE_APPS) {
          return failure(
            409,
            'resource.conflict',
            `This environment already has ${MAX_NATIVE_APPS} native apps. Remove one first.`,
            undefined,
            { max: MAX_NATIVE_APPS }
          )
        }
        const given = body.data
        const identifier = given.platform === 'ios' ? given.bundleId : given.packageName
        if (
          mine.some(
            (entry) => entry.platform === given.platform && identifierOf(entry) === identifier
          )
        ) {
          return failure(
            409,
            'resource.conflict',
            'This environment already has that app. Change it, or remove it first.'
          )
        }
        const stamps = { id: nextId(), environmentId, createdAt: NOW, updatedAt: NOW }
        const app: FakeNativeApp =
          given.platform === 'ios'
            ? { ...stamps, platform: 'ios', teamId: given.teamId, bundleId: given.bundleId }
            : {
                ...stamps,
                platform: 'android',
                packageName: given.packageName,
                sha256CertFingerprints: normalizeCertFingerprints(given.sha256CertFingerprints),
              }
        state.nativeApps.push(app)
        return new Response(JSON.stringify(view(app)), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    ],
    ['GET', /^\/v1\/admin\/native-apps\/([^/]+)$/, onApp(null, view)],
    [
      'PATCH',
      /^\/v1\/admin\/native-apps\/([^/]+)$/,
      onApp(UpdateNativeAppRequestSchema, (app, body) => {
        if (app.platform === 'ios') {
          if (body.sha256CertFingerprints !== undefined) {
            return wrongPlatform(
              'sha256CertFingerprints',
              'An iOS app has no fingerprints. Change its teamId.'
            )
          }
          if (body.teamId !== undefined && body.teamId !== app.teamId) {
            app.teamId = body.teamId
            app.updatedAt = NOW
          }
          return view(app)
        }
        if (body.teamId !== undefined) {
          return wrongPlatform(
            'teamId',
            'An Android app has no team. Change its sha256CertFingerprints.'
          )
        }
        const next = normalizeCertFingerprints(body.sha256CertFingerprints ?? [])
        if (next.join() !== app.sha256CertFingerprints.join()) {
          app.sha256CertFingerprints = next
          app.updatedAt = NOW
        }
        return view(app)
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/native-apps\/([^/]+)$/,
      onApp(null, (app) => {
        state.nativeApps.splice(state.nativeApps.indexOf(app), 1)
        return new Response(null, { status: 204 })
      }),
    ],
  ]
}
