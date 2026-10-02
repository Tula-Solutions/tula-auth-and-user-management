import { ErrorEnvelopeSchema } from '@tula/contract'
import type { GenerateSpecOptions } from 'hono-openapi'
import { resolver } from 'hono-openapi'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'

function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: resolver(ErrorEnvelopeSchema) } },
  }
}

/**
 * Shared error responses. Spread the ones a route can return into its `describeRoute` responses.
 *
 * @example
 * ```ts
 * responses: { 200: { ... }, 401: openapi.responses[401], 422: openapi.responses[422] }
 * ```
 */
export const responses = {
  400: errorResponse('The request could not be read (`request.malformed`).'),
  401: errorResponse('Missing or invalid credentials.'),
  403: errorResponse('Authenticated but not allowed.'),
  404: errorResponse('The resource does not exist in this environment.'),
  409: errorResponse('The change conflicts with existing data.'),
  422: errorResponse('The input is invalid; `errors` lists each field.'),
  429: errorResponse('Rate limited; retry after `params.retryAfter` seconds.'),
  500: errorResponse('Unexpected server error.'),
  501: errorResponse('Capability not implemented yet.'),
} as const

/**
 * Security requirements per route group, for `describeRoute({ security })`.
 *
 * - `public`: no credentials.
 * - `client`: publishable key (browsers and apps).
 * - `session`: publishable key plus a signed-in user's access token.
 * - `admin`: secret key (servers and the dashboard).
 */
export const security = {
  public: [],
  client: [{ publishableKey: [] }],
  session: [{ publishableKey: [], accessToken: [] }],
  admin: [{ secretKey: [] }],
} satisfies Record<string, Record<string, string[]>[]>

/** Top-level OpenAPI document settings. Deterministic, so the committed snapshot is stable. */
export const documentation: GenerateSpecOptions['documentation'] = {
  openapi: '3.1.0',
  info: {
    title: 'Tula Auth API',
    version: '0.0.0',
    description:
      'Self-hostable authentication and user management. Client routes (`/v1/client/*`) take a ' +
      'publishable key; admin routes (`/v1/admin/*`) take a secret key. Every error body is an ' +
      '`ErrorEnvelope` with a stable `code`.',
  },
  tags: [
    { name: 'Status', description: 'Liveness and readiness.' },
    { name: 'Project', description: 'Environments and API keys (admin).' },
    { name: 'Keys', description: 'Access-token signing keys and the public JWKS.' },
    { name: 'Passwords', description: 'Password rules for the live checklist.' },
    { name: 'Sessions', description: 'Refresh, sign-out and the signed-in user’s devices.' },
  ],
  components: {
    securitySchemes: {
      publishableKey: {
        type: 'apiKey',
        in: 'header',
        name: PUBLISHABLE_KEY_HEADER,
        description: 'Publishable key `tula_pk_<env>_…`. Safe to embed in apps.',
      },
      accessToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'EdDSA access token from a Tula session.',
      },
      secretKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Secret key `tula_sk_<env>_…`. Server-side only.',
      },
    },
  },
}
