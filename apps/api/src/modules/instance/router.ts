import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { instanceAdmin } from '~/middleware/instance-admin'
import * as Instance from '~/modules/instance/service'
import * as openapi from '~/openapi'
import { InstanceDiagnosticsSchema } from './schema'

const router = new Hono<AppEnv>()

router.get(
  '/diagnostics',
  describeRoute({
    operationId: 'getInstanceDiagnostics',
    tags: ['Instance'],
    summary: 'Diagnose the deployment',
    description:
      'Checks what actually goes wrong in a deployment, each with its fix: the database and its migrations, `TULA_MASTER_KEY` against the stored secrets, the mail relay, Redis, the clocks, `PUBLIC_URL`, and the redirect URI of each enabled OAuth provider. Nothing is changed and no email is sent. The text of a check is fixed: it never carries a connection string, a key or a driver’s message.\n\nTakes the instance admin token (`TULA_ADMIN_TOKEN`). A deployment without one answers 404.',
    security: openapi.security.instance,
    responses: {
      200: {
        description: 'The checks. A failing check is a 200 with `status: "fail"`.',
        content: { 'application/json': { schema: resolver(InstanceDiagnosticsSchema) } },
      },
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.instanceResponses,
    },
  }),
  instanceAdmin(),
  async (c) => {
    c.header('cache-control', 'no-store')
    return c.json(InstanceDiagnosticsSchema.parse(await Instance.diagnostics(c.get('deps'))))
  }
)

export default router
