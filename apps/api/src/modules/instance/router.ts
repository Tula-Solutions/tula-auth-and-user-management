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
      'Checks what actually goes wrong in a deployment, each with its fix: the database and its migrations, `TULA_MASTER_KEY` against the stored secrets, the mail relay, Redis, the clocks, `PUBLIC_URL`, the redirect URI of each enabled OAuth provider, whether webhook events wait with nothing delivering them, whether text messages can be sent, and the native apps (`native_app_identities`, `native_app_files`, `native_app_passkeys`: each registered app is well formed, the association files name exactly the registered apps and are served at `PUBLIC_URL`, and the passkey relying party is a domain an app can be associated with; `skipped` when no app is registered). The server requests no address but its own `PUBLIC_URL`: whether a platform can reach the files at an operator’s own domain is not checked. Nothing is changed and no email is sent. The text of a check is fixed: it never carries a connection string, a key or a driver’s message.\n\nTakes the instance admin token (`TULA_ADMIN_TOKEN`). A deployment without one answers 404.',
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
