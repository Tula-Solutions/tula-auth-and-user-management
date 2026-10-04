import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import * as openapi from '~/openapi'
import {
  ClientConfigSchema,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsStateSchema,
} from './schema'

/**
 * How long a client may reuse `/v1/client/config`. Short, because it decides what a sign-in
 * screen offers; the server enforces the settings whatever a client has cached.
 */
export const CLIENT_CONFIG_MAX_AGE_SECONDS = 60

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const etagHeader = {
  ETag: {
    description: 'The revision, quoted: the value to send as `If-Match` when replacing.',
    schema: { type: 'string' as const, example: '"3"' },
  },
}

router.get(
  '/admin/settings',
  describeRoute({
    operationId: 'getEnvironmentSettings',
    tags: ['Settings'],
    summary: 'Read the environment’s settings',
    description:
      'The settings of the secret key’s environment: app name, password policy, sign-in ' +
      'methods, allowed origins and redirect URLs, audit retention. An environment that has ' +
      'saved none answers revision 0 with the deployment’s defaults.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The settings and their revision.',
        headers: etagHeader,
        content: json(EnvironmentSettingsStateSchema),
      },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    // Past the cache: the revision returned is the one the next replace is checked against.
    const state = await Settings.get(c.get('deps'), c.get('tenant'), true)
    c.header('ETag', Settings.etag(state.revision))
    c.header('Cache-Control', 'no-store')
    return c.json(EnvironmentSettingsStateSchema.parse(state))
  }
)

router.put(
  '/admin/settings',
  describeRoute({
    operationId: 'replaceEnvironmentSettings',
    tags: ['Settings'],
    summary: 'Replace the environment’s settings',
    description:
      'Replaces the whole document: a section or field left out takes its default, and an ' +
      'unknown key is refused. Two defaults are the deployment’s rather than the schema’s: ' +
      'a `password` section that is left out takes the deployment’s `PASSWORD_POLICY`, and a ' +
      '`urls.allowedOrigins` that is left out takes its `CORS_ORIGINS` (the values `GET` ' +
      'returns at revision 0), so a partial document never loosens the policy or locks ' +
      'browser apps out by accident; a value that is sent, an empty list included, is taken ' +
      'as sent. If the deployment’s default for a field that was left out is one settings ' +
      'cannot store (a plain-http origin in `CORS_ORIGINS`), the request is refused with a ' +
      'field error and that field has to be sent explicitly. `password.minLength` cannot be ' +
      'set below 8. `If-Match` must carry the revision that was read (the `ETag` ' +
      'of the last response), so two writers cannot silently overwrite each other: a missing ' +
      'header is `precondition.required`, a revision that is no longer current is ' +
      '`precondition.failed`. The change is recorded in the audit log as ' +
      '`environment.settings_updated` with the keys that changed, never their values, and ' +
      '`weakened: true` when it made the password policy weaker. ' +
      'Other API instances apply it within a few seconds.',
    security: openapi.security.admin,
    parameters: [
      {
        name: 'If-Match',
        in: 'header',
        required: true,
        description: 'The revision being replaced, quoted, e.g. `"3"` (`"0"` for the first save).',
        schema: { type: 'string' },
      },
    ],
    responses: {
      200: {
        description: 'The settings now in force and their revision.',
        headers: etagHeader,
        content: json(EnvironmentSettingsStateSchema),
      },
      400: openapi.responses[400],
      401: openapi.responses[401],
      412: openapi.responses[412],
      413: openapi.responses[413],
      422: openapi.responses[422],
      428: openapi.responses[428],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', EnvironmentSettingsInputSchema, validationHook),
  async (c) => {
    const state = await Settings.replace(
      c.get('deps'),
      c.get('tenant'),
      {
        expectedRevision: Settings.expectedRevision(c.req.header('if-match')),
        settings: c.req.valid('json'),
      },
      adminActor(c)
    )
    c.header('ETag', Settings.etag(state.revision))
    c.header('Cache-Control', 'no-store')
    return c.json(EnvironmentSettingsStateSchema.parse(state))
  }
)

router.get(
  '/client/config',
  describeRoute({
    operationId: 'getClientConfig',
    tags: ['Settings'],
    summary: 'Client configuration',
    description:
      'What a client needs to draw a sign-in screen for this environment: the app’s name and ' +
      'support address, the enabled sign-in methods and OAuth providers and the password policy. Ignore methods ' +
      'you do not know. Nothing here is secret.',
    security: openapi.security.client,
    responses: {
      200: { description: 'The configuration.', content: json(ClientConfigSchema) },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  publishableKey(),
  async (c) => {
    const settings = await Settings.current(c.get('deps'), c.get('tenant'))
    const providers = await OAuth.enabledProviders(c.get('deps'), c.get('tenant'))
    c.header('Cache-Control', `private, max-age=${CLIENT_CONFIG_MAX_AGE_SECONDS}`)
    // The response depends on which environment the key belongs to.
    c.header('Vary', PUBLISHABLE_KEY_HEADER, { append: true })
    return c.json(ClientConfigSchema.parse(Settings.clientConfig(settings, providers)))
  }
)

export default router
