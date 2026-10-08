import { CreateHookRequestSchema, HOOK_FIELDS, UpdateHookRequestSchema } from '@tula/contract'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import { invalid, refusedAddress } from './fake-webhooks'

// The fake API's hook routes (`/v1/admin/hooks`): the shapes, the refusals and the error
// codes of `apps/api/src/modules/hook`, on plain in-memory data. No hook is ever asked.
//
// Held to the API by `fake-hooks.test.ts`: what is refused before anything is looked up (an
// id that is no UUID, a body the contract's strict schemas refuse: 422 `validation.failed`,
// with the field), one hook per point per environment (409 `resource.conflict`), the guard
// that judges an address when it is saved and only when it changes, a change that changes
// nothing (nothing moves, `updatedAt` included), and a secret that is in the answer to the
// registration and in no other.
//
// Where it still differs from the API, on purpose:
// - No hook is called, so `lastFailedAt` and `lastFailureReason` are whatever a test wrote.
// - No secret is sealed or opened.
// - The compare-and-set of an update or a removal never misses (nothing changes a hook
//   between the read and the write here). A test that needs that 409 overrides the route.
// - The outbound guard is the fixed rules of `refusedAddress`; nothing is resolved.
// - No rate limit.
// - An environment that does not exist is not a 404 here: a hook is simply not found under
//   it.

const NOW = '2026-10-04T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'

const HookParams = z.object({ id: z.uuid() })

/** A hook as the fake holds it: the API's view, plus the environment it is in. */
export interface FakeHook {
  id: string
  environmentId: string
  point: string
  url: string
  enabled: boolean
  deadlineMs: number
  failureMode: string
  lastFailedAt: string | null
  lastFailureReason: string | null
  createdAt: string
  updatedAt: string
}

/** The part of the fake's state the hook routes work on. */
export interface FakeHookState {
  /** Every environment's hooks, oldest first. */
  hooks: FakeHook[]
  /** The server's clock, as the hook routes read it. Only a test moves it. */
  hookNow: string
}

let made = 0

/**
 * A hook for a test to put in the fake's state: for `before_sign_up`, switched on, refusing
 * on failure, never failed, in the development environment.
 *
 * @param overrides - What differs.
 * @returns The hook.
 */
export function fakeHook(overrides: Partial<FakeHook> = {}): FakeHook {
  made += 1
  return {
    id: `00000000-0000-7000-8000-d${String(made).padStart(11, '0')}`,
    environmentId: IDS.development,
    point: 'before_sign_up',
    url: 'https://api.example.com/hooks/tula/sign-up',
    enabled: true,
    deadlineMs: 2000,
    failureMode: 'deny',
    lastFailedAt: null,
    lastFailureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function view({ environmentId: _environmentId, ...hook }: FakeHook) {
  return hook
}

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

function refusedUrl(reason: string): Response {
  return failure(422, 'hook.url_not_allowed', 'The server cannot call that address.', undefined, {
    reason,
  })
}

/**
 * The hook routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its hook part.
 * @returns The routes, in the fake's own table format.
 */
export function hookRoutes(state: FakeHookState): [string, RegExp, FakeHandler][] {
  let secrets = 0

  function hookOf(call: FakeCall, id: string): FakeHook | undefined {
    return state.hooks.find(
      (entry) => entry.id === id && entry.environmentId === call.headers.get(ENVIRONMENT)
    )
  }

  /**
   * A route on one hook: the path's id is checked as the API checks it, then the body (when
   * the route has one), and only then is anything looked up.
   */
  function onHook<Body>(
    body: z.ZodType<Body> | null,
    handler: (hook: FakeHook, body: Body) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      const params = HookParams.safeParse({ id: match[1] })
      if (!params.success) {
        return invalid(params.error)
      }
      const given = body === null ? null : body.safeParse(call.body ?? {})
      if (given && !given.success) {
        return invalid(given.error)
      }
      const hook = hookOf(call, params.data.id)
      return hook ? handler(hook, given?.data as Body) : notFound()
    }
  }

  return [
    [
      'GET',
      /^\/v1\/admin\/hooks$/,
      (call) => ({
        data: state.hooks
          .filter((entry) => entry.environmentId === call.headers.get(ENVIRONMENT))
          .map(view),
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/hooks$/,
      (call) => {
        const body = CreateHookRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = call.headers.get(ENVIRONMENT) ?? ''
        // The address is judged before the point is looked at.
        const reason = refusedAddress(body.data.url)
        if (reason !== null) {
          return refusedUrl(reason)
        }
        const taken = state.hooks.some(
          (entry) => entry.environmentId === environmentId && entry.point === body.data.point
        )
        if (taken) {
          return failure(
            409,
            'resource.conflict',
            'This environment already has a hook for that point. Change it, or remove it first.'
          )
        }
        const hook = fakeHook({
          environmentId,
          ...body.data,
          createdAt: state.hookNow,
          updatedAt: state.hookNow,
        })
        state.hooks.push(hook)
        secrets += 1
        return new Response(
          JSON.stringify({
            ...view(hook),
            secret: `whsec_ZmFrZWhvb2tzZWNyZXRmb3J0ZXN0c29ubHk${secrets}`,
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          }
        )
      },
    ],
    ['GET', /^\/v1\/admin\/hooks\/([^/]+)$/, onHook(null, view)],
    [
      'PATCH',
      /^\/v1\/admin\/hooks\/([^/]+)$/,
      onHook(UpdateHookRequestSchema, (hook, body) => {
        // Only what differs is a change, and only a changed address is judged.
        const changed = HOOK_FIELDS.filter(
          (field) => body[field] !== undefined && body[field] !== hook[field]
        )
        if (changed.includes('url')) {
          const reason = refusedAddress(body.url as string)
          if (reason !== null) {
            return refusedUrl(reason)
          }
        }
        if (changed.length > 0) {
          Object.assign(hook, Object.fromEntries(changed.map((field) => [field, body[field]])))
          hook.updatedAt = state.hookNow
        }
        return view(hook)
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/hooks\/([^/]+)$/,
      onHook(null, (hook) => {
        state.hooks.splice(state.hooks.indexOf(hook), 1)
        return new Response(null, { status: 204 })
      }),
    ],
  ]
}
