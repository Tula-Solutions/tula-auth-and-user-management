import { describe, expect, test } from 'bun:test'
import { createApp, OPENAPI_PATH } from '~/index'
import { createTestDeps } from '~/testing'

interface Operation {
  operationId?: string
  security?: Record<string, string[]>[]
  responses?: Record<string, unknown>
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const

/** Every operation of the generated document, with its method and path. */
async function operations(): Promise<Array<Operation & { method: string; path: string }>> {
  const res = await createApp(createTestDeps()).request(OPENAPI_PATH)
  expect(res.status).toBe(200)
  const document = (await res.json()) as { paths: Record<string, Record<string, Operation>> }
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => (item[method] ? [{ ...item[method], method, path }] : []))
  )
}

/**
 * What the dashboard's way in can answer on any operation it authenticates, before the
 * handler runs (`secretKey()`, `instanceAdmin()`, `requireDashboardSession`):
 *
 * - 400: two credentials at once, or an admin call without `x-tula-environment`;
 * - 401: no valid session (or key);
 * - 403: `request.origin_not_allowed`, the CSRF rules;
 * - 404: an unknown `x-tula-environment`, or a deployment with no admin token.
 */
const DASHBOARD_ANSWERS = ['400', '401', '403', '404'] as const

describe('the OpenAPI document and the dashboard session', () => {
  test('every operation a dashboard session can authenticate documents 400, 401, 403 and 404', async () => {
    const all = await operations()
    const dashboard = all.filter((operation) =>
      operation.security?.some((alternative) => 'dashboardSession' in alternative)
    )
    // Both groups are there: the walk is not vacuous.
    expect(dashboard.some(({ path }) => path.startsWith('/v1/admin/'))).toBe(true)
    expect(dashboard.some(({ path }) => path.startsWith('/v1/instance/'))).toBe(true)
    expect(dashboard.length).toBeGreaterThanOrEqual(30)
    const missing = dashboard.flatMap((operation) =>
      DASHBOARD_ANSWERS.filter((status) => !(status in (operation.responses ?? {}))).map(
        (status) => `${operation.method.toUpperCase()} ${operation.path}: ${status}`
      )
    )
    expect(missing).toEqual([])
  })
})
