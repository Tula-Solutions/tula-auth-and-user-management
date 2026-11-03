import {
  CLIENT_HEADER,
  FLOW_ATTEMPT_HEADER,
  PUBLISHABLE_KEY_HEADER,
} from '@tula-tech/contract/headers'
import { OPERATIONS, type OperationId } from './api-types'
import { errorResponse, SandboxError } from './errors'
import { HANDLERS } from './handlers'
import { SANDBOX_ORIGIN } from './helpers'
import type { World } from './world'

// The sandbox as a `fetch`: what `createTulaClient({ fetch })` is handed, so that the real
// components and the real client run unchanged against the in-browser API. The routes are the
// generated `OPERATIONS` table's, so a path or a method cannot differ from the contract's.

/** The publishable key the sandbox's client is created with. It names no real environment. */
export const SANDBOX_PUBLISHABLE_KEY = 'tula_pk_dev_sandbox00000000000000000000'

/** Where the sandbox's client believes the API is. `.invalid` never resolves: nothing is called. */
export const SANDBOX_BASE_URL = SANDBOX_ORIGIN

interface Route {
  id: OperationId
  method: string
  pattern: RegExp
  names: string[]
}

const ROUTES: Route[] = (Object.keys(OPERATIONS) as OperationId[]).map((id) => {
  const { method, path } = OPERATIONS[id]
  const names: string[] = []
  const source = path
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name)
      return '([^/]+)'
    })
  return { id, method, names, pattern: new RegExp(`^${source}$`) }
})

/** Options of {@link createSandboxFetch}. */
export interface SandboxFetchOptions {
  /** A pause before each answer, in milliseconds, so that a button visibly works. Default 0. */
  latencyMs?: number
}

function clientKind(request: Request): 'web' | 'ios' | 'android' | 'server' {
  const value = request.headers.get(CLIENT_HEADER)
  return value === 'ios' || value === 'android' || value === 'server' ? value : 'web'
}

/**
 * Make the sandbox's `fetch`.
 *
 * @param world - The sandbox state it answers from.
 * @param options - A latency.
 * @returns A function of the shape the client takes as `fetch`.
 *
 * @example
 * ```ts
 * const world = createWorld()
 * const tula = createTulaClient({
 *   publishableKey: SANDBOX_PUBLISHABLE_KEY,
 *   baseUrl: SANDBOX_BASE_URL,
 *   fetch: createSandboxFetch(world),
 * })
 * ```
 */
export function createSandboxFetch(
  world: World,
  options: SandboxFetchOptions = {}
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs))
    }
    const url = new URL(request.url)
    if (url.origin !== SANDBOX_ORIGIN) {
      // The sandbox answers for its own address only: nothing leaves the page.
      return errorResponse(new SandboxError('resource.not_found'))
    }
    const route = ROUTES.find(
      (candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname)
    )
    if (!route) {
      return errorResponse(new SandboxError('resource.not_found'))
    }
    try {
      if (!request.headers.get(PUBLISHABLE_KEY_HEADER)?.startsWith('tula_pk_')) {
        throw new SandboxError('auth.invalid_key')
      }
      const match = route.pattern.exec(url.pathname) as RegExpExecArray
      const params: Record<string, string> = {}
      route.names.forEach((name, at) => {
        params[name] = decodeURIComponent(match[at + 1] as string)
      })
      let raw: unknown
      const body = await request.text()
      if (body !== '') {
        try {
          raw = JSON.parse(body)
        } catch {
          throw new SandboxError('request.malformed')
        }
      }
      if (OPERATIONS[route.id].method !== 'GET' && OPERATIONS[route.id].method !== 'DELETE') {
        // A body that is a string, a number or a list is not one of the API's.
        if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
          throw new SandboxError('request.malformed')
        }
      }
      const authorization = request.headers.get('authorization')
      const handler = HANDLERS[route.id] as (ctx: unknown) => unknown
      const answer = await handler({
        world,
        params,
        // A route that takes a body reads its fields; one that takes none gets `undefined`.
        body: raw ?? (OPERATIONS[route.id].method === 'POST' ? {} : undefined),
        raw,
        attemptSecret: request.headers.get(FLOW_ATTEMPT_HEADER),
        accessToken: authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
        client: clientKind(request),
      })
      if (answer === undefined) {
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    } catch (error) {
      if (error instanceof SandboxError) {
        return errorResponse(error)
      }
      // A bug in the sandbox is not a sign-in failure: say so, with the contract's own code.
      return errorResponse(new SandboxError('internal'))
    }
  }
}
