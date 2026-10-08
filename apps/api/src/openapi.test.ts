import { describe, expect, test } from 'bun:test'
import { ACTIVITY_TYPES, EVENT_DATA_SCHEMAS, EVENT_FIXTURES, EVENT_SCHEMAS } from '@tula/contract'
import { z } from 'zod'
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

describe('the event payloads in the OpenAPI document', () => {
  interface Component {
    oneOf?: { $ref: string }[]
    properties?: Record<string, { $ref?: string; const?: unknown }>
    required?: string[]
  }

  async function document() {
    const res = await createApp(createTestDeps()).request(OPENAPI_PATH)
    return (await res.json()) as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, Component>; securitySchemes: Record<string, unknown> }
    }
  }

  const refOf = (schema: z.ZodType) => String(z.globalRegistry.get(schema)?.ref)
  const component = (schema: z.ZodType) => `#/components/schemas/${refOf(schema)}`

  test('every activity type has an event component and a data component', async () => {
    const { schemas } = (await document()).components
    for (const type of ACTIVITY_TYPES) {
      const event = schemas[refOf(EVENT_SCHEMAS[type])]
      expect(event?.properties?.type?.const).toBe(type)
      expect(event?.properties?.schemaVersion?.const).toBe(EVENT_FIXTURES[type].schemaVersion)
      expect(event?.required).toEqual([
        'id',
        'type',
        'schemaVersion',
        'occurredAt',
        'actor',
        'target',
        'data',
      ])
      expect(event?.properties?.data?.$ref).toBe(component(EVENT_DATA_SCHEMAS[type]))
      expect(
        Object.keys(schemas[refOf(EVENT_DATA_SCHEMAS[type])]?.properties ?? {}).sort()
      ).toEqual(Object.keys(EVENT_DATA_SCHEMAS[type].shape).sort())
    }
  })

  test('`Event` is one of them, by reference, and nothing else', async () => {
    const { schemas } = (await document()).components
    expect(schemas.Event?.oneOf?.map((one) => one.$ref).sort()).toEqual(
      ACTIVITY_TYPES.map((type) => component(EVENT_SCHEMAS[type])).sort()
    )
  })

  test('they are components only: no route refers to one, and the rest is still there', async () => {
    const { paths, components } = await document()
    const referred = JSON.stringify(paths).match(/#\/components\/schemas\/\w+/g) ?? []
    expect(referred.length).toBeGreaterThan(0)
    expect(referred.filter((ref) => /Event(Data|Actor)?$/.test(ref))).toEqual([])
    // The components the routes bring, and the security schemes, are merged in, not replaced.
    expect(components.schemas.ErrorEnvelope).toBeDefined()
    expect(components.schemas.AuditLog).toBeDefined()
    expect(components.securitySchemes.secretKey).toBeDefined()
  })

  test('the document is built once and served again', async () => {
    const app = createApp(createTestDeps())
    const first = await (await app.request(OPENAPI_PATH)).text()
    expect(await (await app.request(OPENAPI_PATH)).text()).toBe(first)
  })
})
