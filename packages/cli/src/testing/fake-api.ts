import type { AdminFetch } from '@tula/admin'
import {
  type EnvironmentSettings,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  hasEnabledSignInMethod,
  OAUTH_PROVIDERS,
} from '@tula/contract'

// A stand-in for the admin API, for this package's own tests: the settings document with its
// revision and manager, and the providers, with the rules a run depends on (If-Match, "at
// least one way to sign in"). The real API is driven by the same CLI in
// `apps/api/src/cli.test.ts`.

interface Manager {
  tool: string
  configHash: string
  at: string
  revision: number
}

interface Provider {
  clientId: string
  teamId: string | null
  keyId: string | null
  /** Microsoft's tenant; absent for every other provider. */
  tenant?: string | null
  enabled: boolean
  /** Kept so that a test can check which secret was stored. Never answered. */
  secret: string | undefined
}

/** The fake's state and the requests it saw. */
export interface FakeApi {
  fetch: AdminFetch
  /** `METHOD /path` of every request, in order. */
  requests: string[]
  /** Headers of every request, in order. */
  headers: Headers[]
  revision: number
  settings: EnvironmentSettings
  managedBy: Manager | null
  providers: Map<string, Provider>
  /** Answer a request in the fake's place. */
  intercept?: (method: string, path: string) => Response | undefined
  /** An older server: no `managedBy` in the answer. */
  legacy: boolean
}

function problem(status: number, code: string, detail: string, extra: object = {}): Response {
  return Response.json({ status, code, detail, ...extra }, { status })
}

/**
 * Build a fake admin API.
 *
 * @param baseUrl - The URL the CLI is pointed at.
 * @returns The fake: pass its `fetch` to the run, then read its state.
 */
export function createFakeApi(baseUrl: string): FakeApi {
  const api: FakeApi = {
    requests: [],
    headers: [],
    revision: 0,
    settings: EnvironmentSettingsSchema.parse({}),
    managedBy: null,
    providers: new Map(),
    legacy: false,
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET'
      const path = url.slice(baseUrl.length)
      const headers = new Headers(init?.headers)
      api.requests.push(`${method} ${path}`)
      api.headers.push(headers)
      const intercepted = api.intercept?.(method, path)
      if (intercepted) {
        return intercepted
      }
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      if (path === '/v1/admin/settings') {
        return method === 'GET' ? state() : replace(headers, body)
      }
      if (path === '/v1/admin/oauth-providers') {
        return Response.json({ data: OAUTH_PROVIDERS.map(listed) })
      }
      const name = path.slice('/v1/admin/oauth-providers/'.length)
      return method === 'DELETE' ? remove(name) : set(name, body as Record<string, unknown>)
    },
  }

  const wayIn = (settings: EnvironmentSettings, providers = api.providers) =>
    hasEnabledSignInMethod(settings) || [...providers.values()].some((entry) => entry.enabled)
  const noWayIn = () =>
    problem(422, 'validation.failed', 'Some fields are invalid.', {
      errors: [
        {
          field: 'signIn.methods',
          code: 'validation.failed',
          message: 'at least one sign-in method must stay enabled',
        },
      ],
    })

  function state(): Response {
    const managedBy = api.managedBy
      ? { ...api.managedBy, drifted: api.managedBy.revision !== api.revision }
      : null
    return Response.json(
      { revision: api.revision, settings: api.settings, ...(!api.legacy && { managedBy }) },
      { headers: { etag: `"${api.revision}"` } }
    )
  }

  function replace(headers: Headers, body: unknown): Response {
    if (headers.get('if-match') !== `"${api.revision}"`) {
      return problem(412, 'precondition.failed', 'The settings changed since you read them.', {
        params: { revision: api.revision },
      })
    }
    const parsed = EnvironmentSettingsInputSchema.safeParse(body)
    if (!parsed.success) {
      return problem(422, 'validation.failed', 'Some fields are invalid.')
    }
    const settings = EnvironmentSettingsSchema.parse(parsed.data)
    if (!wayIn(settings)) {
      return noWayIn()
    }
    api.revision += 1
    api.settings = settings
    const tool = headers.get('x-tula-managed-by')
    const configHash = headers.get('x-tula-config-hash')
    if (tool && configHash) {
      api.managedBy = { tool, configHash, at: '2026-01-01T00:00:00.000Z', revision: api.revision }
    }
    return state()
  }

  function listed(name: string) {
    const entry = api.providers.get(name)
    return {
      provider: name,
      configured: entry !== undefined,
      enabled: entry?.enabled ?? false,
      clientId: entry?.clientId ?? null,
      teamId: entry?.teamId ?? null,
      keyId: entry?.keyId ?? null,
      tenant: entry?.tenant ?? null,
      callbackUrl: `${baseUrl}/v1/oauth/${name}/callback`,
      updatedAt: entry ? '2026-01-01T00:00:00.000Z' : null,
    }
  }

  function set(name: string, body: Record<string, unknown>): Response {
    const before = api.providers.get(name)
    const next: Provider = {
      clientId: String(body.clientId),
      teamId: typeof body.teamId === 'string' ? body.teamId : null,
      keyId: typeof body.keyId === 'string' ? body.keyId : null,
      ...(typeof body.tenant === 'string' && { tenant: body.tenant }),
      enabled: body.enabled !== false,
      secret:
        (body.clientSecret as string | undefined) ??
        (body.privateKey as string | undefined) ??
        before?.secret,
    }
    const providers = new Map(api.providers).set(name, next)
    if (!wayIn(api.settings, providers)) {
      return noWayIn()
    }
    api.providers = providers
    return Response.json(listed(name))
  }

  function remove(name: string): Response {
    const providers = new Map(api.providers)
    providers.delete(name)
    if (!wayIn(api.settings, providers)) {
      return noWayIn()
    }
    api.providers = providers
    return new Response(null, { status: 204 })
  }

  return api
}
