import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import * as Status from '~/modules/status/service'
import * as openapi from '~/openapi'
import { ReadinessResponseSchema, StatusResponseSchema } from './schema'

const router = new Hono<AppEnv>()

router.get(
  '/status',
  describeRoute({
    operationId: 'getStatus',
    tags: ['Status'],
    summary: 'Liveness check',
    description: 'Returns 200 while the process is running. Does not check dependencies.',
    security: openapi.security.public,
    responses: {
      200: {
        description: 'The API is running.',
        content: { 'application/json': { schema: resolver(StatusResponseSchema) } },
      },
      500: openapi.responses[500],
    },
  }),
  (c) => c.json(StatusResponseSchema.parse(Status.status()))
)

router.get(
  '/ready',
  describeRoute({
    operationId: 'getReadiness',
    tags: ['Status'],
    summary: 'Readiness check',
    description: 'Returns 200 when every dependency is reachable, 503 otherwise.',
    security: openapi.security.public,
    responses: {
      200: {
        description: 'Ready to take traffic.',
        content: { 'application/json': { schema: resolver(ReadinessResponseSchema) } },
      },
      500: openapi.responses[500],
      503: {
        description: 'A dependency is unavailable.',
        content: { 'application/json': { schema: resolver(ReadinessResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const result = ReadinessResponseSchema.parse(await Status.ready(c.get('deps')))
    return c.json(result, result.status === 'ready' ? 200 : 503)
  }
)

export default router
