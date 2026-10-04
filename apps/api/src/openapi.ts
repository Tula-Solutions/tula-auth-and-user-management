import { DASHBOARD_SESSION_COOKIE, ErrorEnvelopeSchema } from '@tula/contract'
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
  410: errorResponse('The code or link has expired; request a new one.'),
  412: errorResponse(
    'The resource is no longer at the revision in `If-Match` (`precondition.failed`); read it again.'
  ),
  413: errorResponse('The request body is larger than 64 KiB (`request.too_large`).'),
  422: errorResponse('The input is invalid; `errors` lists each field.'),
  428: errorResponse('The request needs an `If-Match` header (`precondition.required`).'),
  429: errorResponse('Rate limited; retry after `params.retryAfter` seconds.'),
  500: errorResponse('Unexpected server error.'),
  501: errorResponse('Capability not implemented yet.'),
  503: errorResponse(
    'A dependency is unreachable and the request was refused (`service.unavailable`); retry.'
  ),
} as const

/**
 * Security requirements per route group, for `describeRoute({ security })`.
 *
 * - `public`: no credentials.
 * - `client`: publishable key (browsers and apps).
 * - `session`: publishable key plus a signed-in user's access token.
 * - `admin`: a secret key (servers), or a dashboard session together with the
 *   `x-tula-environment` header (the dashboard).
 * - `instance`: the instance admin token (`TULA_ADMIN_TOKEN`) or a dashboard session, for
 *   `/v1/instance/*`.
 * - `instanceToken`: the instance admin token only.
 * - `dashboard`: a dashboard session only.
 */
/** One alternative of a route's security: the schemes that must all be presented. */
type SecurityRequirement = Record<string, string[]>

export const security: Record<
  'public' | 'client' | 'session' | 'admin' | 'instance' | 'instanceToken' | 'dashboard',
  SecurityRequirement[]
> = {
  public: [],
  client: [{ publishableKey: [] }],
  session: [{ publishableKey: [], accessToken: [] }],
  admin: [{ secretKey: [] }, { dashboardSession: [] }],
  instance: [{ instanceAdminToken: [] }, { dashboardSession: [] }],
  instanceToken: [{ instanceAdminToken: [] }],
  dashboard: [{ dashboardSession: [] }],
}

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
    {
      name: 'Flows',
      description:
        'Server-driven sign-up and sign-in. Each call returns the next step; clients render it.',
    },
    { name: 'Users', description: 'Manage users (admin) and the signed-in user’s own account.' },
    {
      name: 'Sessions',
      description: 'Refresh, sign-out, step-up and the signed-in user’s devices.',
    },
    {
      name: 'MFA',
      description:
        'Two-step verification: an authenticator app (TOTP) and backup codes for the signed-in ' +
        'user, and the admin reset.',
    },
    {
      name: 'OAuth',
      description:
        'Sign-in with Google, GitHub and Apple: provider credentials (admin), the provider callback, and a user’s connected accounts.',
    },
    {
      name: 'Settings',
      description:
        'Per-environment settings (admin) and the public configuration clients draw from them.',
    },
    { name: 'Audit', description: 'The record of auth events and admin actions (admin).' },
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
      instanceAdminToken: {
        type: 'http',
        scheme: 'bearer',
        description:
          'The instance admin token (`TULA_ADMIN_TOKEN`). The operator of the deployment only; the routes that take it answer 404 where none is configured.',
      },
      dashboardSession: {
        type: 'apiKey',
        in: 'cookie',
        name: DASHBOARD_SESSION_COOKIE,
        description:
          'The dashboard session cookie set by `POST /v1/instance/session` (`__Secure-tula_dashboard` over https). A browser credential: every request made with it carries `x-tula-dashboard: 1`, an `Origin` that is the API’s own or on `CORS_ORIGINS` (required on anything but a read), and no `Authorization` header. On `/v1/admin/*` it also names the environment in `x-tula-environment`.',
      },
    },
  },
}
