import { MAX_CERT_FINGERPRINTS, MAX_NATIVE_APPS } from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as NativeApps from '~/modules/native-app/service'
import * as openapi from '~/openapi'
import {
  AppleAppSiteAssociationSchema,
  AssetLinksSchema,
  AssociationParamSchema,
  CreateNativeAppRequestSchema,
  NativeAppIdParamSchema,
  NativeAppListSchema,
  NativeAppSchema,
  UpdateNativeAppRequestSchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const weakening =
  'Registering an app, moving an iOS app to another team and giving an Android app a ' +
  'fingerprint more each widen which app the served files name: the audit entry of such a ' +
  'change carries `weakened: true`.'

const fingerprints =
  'A fingerprint is the SHA-256 of a signing certificate: 32 bytes as hex pairs joined by ' +
  'colons, in either case, or as 64 hex digits. It is stored and served upper case with ' +
  `colons. An app has between one and ${MAX_CERT_FINGERPRINTS}, each once.`

const whereServed =
  'A platform fetches the file from the root of the domain the app claims, never from this ' +
  'path: the operator’s site or proxy answers `/.well-known/…` on that domain with what ' +
  'this path returns (a rewrite, not a redirect). The environment is the one in the path ' +
  'and nothing else of the request chooses it.'

/**
 * The limit of the two public files: per address, and open when the limiter's store is down.
 * The files are public and name only what an operator registered to be named; an outage of
 * the limiter must not make a platform's fetch fail (ADR 0016).
 */
const associationRateLimit = () =>
  rateLimit({
    name: 'app_association',
    limit: 600,
    window: '1m',
    key: byIp,
    whenUnavailable: 'allow',
  })

const associationResponses = {
  404: openapi.responses[404],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
}

router.get(
  '/environments/:environmentId/.well-known/apple-app-site-association',
  describeRoute({
    operationId: 'getAppleAppSiteAssociation',
    tags: ['Native apps'],
    summary: 'Apple’s app-site-association file',
    description:
      'The `apple-app-site-association` document of the environment, built from its ' +
      'registered iOS apps: each is named as `<team id>.<bundle id>` under `webcredentials`, ' +
      'which lets the app use the passkeys and saved passwords of the domain the file is ' +
      'served from. There is no `applinks` section. With no iOS app registered the document ' +
      `is \`{}\`. ${whereServed}`,
    security: openapi.security.public,
    responses: {
      200: { description: 'The document.', content: json(AppleAppSiteAssociationSchema) },
      ...associationResponses,
    },
  }),
  associationRateLimit(),
  validator('param', AssociationParamSchema, validationHook),
  async (c) => {
    const file = await NativeApps.appleAppSiteAssociation(
      c.get('deps'),
      c.req.valid('param').environmentId
    )
    c.header('Cache-Control', `public, max-age=${NativeApps.ASSOCIATION_MAX_AGE_SECONDS}`)
    return c.json(AppleAppSiteAssociationSchema.parse(file))
  }
)

router.get(
  '/environments/:environmentId/.well-known/assetlinks.json',
  describeRoute({
    operationId: 'getAssetLinks',
    tags: ['Native apps'],
    summary: 'Android’s asset-links file',
    description:
      'The Digital Asset Links statements of the environment, built from its registered ' +
      'Android apps: one statement per app, with its package name, its certificate ' +
      'fingerprints and the relation `delegate_permission/common.get_login_creds`, which ' +
      'lets the app use the passkeys and saved passwords of the domain the file is served ' +
      'from. `handle_all_urls` is not served. With no Android app registered the document ' +
      `is \`[]\`. ${whereServed}`,
    security: openapi.security.public,
    responses: {
      200: { description: 'The statements.', content: json(AssetLinksSchema) },
      ...associationResponses,
    },
  }),
  associationRateLimit(),
  validator('param', AssociationParamSchema, validationHook),
  async (c) => {
    const file = await NativeApps.assetLinks(c.get('deps'), c.req.valid('param').environmentId)
    c.header('Cache-Control', `public, max-age=${NativeApps.ASSOCIATION_MAX_AGE_SECONDS}`)
    return c.json(AssetLinksSchema.parse(file))
  }
)

router.get(
  '/admin/native-apps',
  describeRoute({
    operationId: 'listNativeApps',
    tags: ['Native apps'],
    summary: 'List native apps',
    description:
      'The native apps registered for the environment, oldest first. They are what its two ' +
      'association files are built from.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The apps.', content: json(NativeAppListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await NativeApps.list(c.get('deps'), c.get('tenant'))
    return c.json(NativeAppListSchema.parse({ data }))
  }
)

router.post(
  '/admin/native-apps',
  describeRoute({
    operationId: 'createNativeApp',
    tags: ['Native apps'],
    summary: 'Register a native app',
    description:
      'Registers an iOS app (its Apple team and bundle id) or an Android app (its package ' +
      'name and the fingerprints of its signing certificates) as the environment’s own. The ' +
      'environment’s association files name it from then on. An environment has one app per ' +
      'platform and bundle id or package name (a second is refused with `resource.conflict`, ' +
      `409) and at most ${MAX_NATIVE_APPS} apps (the same code, with \`params.max\`). ` +
      `${fingerprints} ${weakening}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The registered app.', content: json(NativeAppSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateNativeAppRequestSchema, validationHook),
  async (c) => {
    const created = await NativeApps.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(NativeAppSchema.parse(created), 201)
  }
)

router.get(
  '/admin/native-apps/:id',
  describeRoute({
    operationId: 'getNativeApp',
    tags: ['Native apps'],
    summary: 'Get a native app',
    description: 'One native app of the environment.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The app.', content: json(NativeAppSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', NativeAppIdParamSchema, validationHook),
  async (c) => {
    const app = await NativeApps.get(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
    return c.json(NativeAppSchema.parse(app))
  }
)

router.patch(
  '/admin/native-apps/:id',
  describeRoute({
    operationId: 'updateNativeApp',
    tags: ['Native apps'],
    summary: 'Change a native app',
    description:
      'Changes an iOS app’s `teamId`, or replaces an Android app’s `sha256CertFingerprints` ' +
      'with the set given. A field of the other platform is refused (`validation.failed`, ' +
      '422). The platform and the bundle id or package name cannot be changed: register the ' +
      'other app and remove this one. Recorded in the audit log by the names of the fields ' +
      'that changed, never their values. An app that someone else changed meanwhile is not ' +
      `written over (\`resource.conflict\`, 409). ${fingerprints} ${weakening}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The app as it is now.', content: json(NativeAppSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', NativeAppIdParamSchema, validationHook),
  validator('json', UpdateNativeAppRequestSchema, validationHook),
  async (c) => {
    const updated = await NativeApps.update(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(NativeAppSchema.parse(updated))
  }
)

router.delete(
  '/admin/native-apps/:id',
  describeRoute({
    operationId: 'deleteNativeApp',
    tags: ['Native apps'],
    summary: 'Remove a native app',
    description:
      'Removes the app: the environment’s association files no longer name it. A platform ' +
      'that already fetched a file keeps its copy for as long as it chooses to.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', NativeAppIdParamSchema, validationHook),
  async (c) => {
    await NativeApps.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').id, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
