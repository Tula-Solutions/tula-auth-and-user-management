import { MAX_CUSTOM_ROLES, MAX_PERMISSIONS_PER_ROLE } from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Roles from '~/modules/organization-role/service'
import * as Settings from '~/modules/settings/service'
import * as openapi from '~/openapi'
import {
  CreateOrganizationRoleRequestSchema,
  OrganizationRoleListSchema,
  OrganizationRoleSchema,
  RoleKeyParamSchema,
  UpdateOrganizationRoleRequestSchema,
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

const disabled =
  'While the environment’s `organizations.enabled` setting is off, every organization route ' +
  'answers `organization.disabled` (403) and touches nothing.'

const permissions =
  'A permission is `org:<feature>:<action>` in lower case (`org:billing:read`) and a role ' +
  `holds at most ${MAX_PERMISSIONS_PER_ROLE}, each once. A role may also hold any of Tula’s ` +
  'own system permissions (`org:sys:memberships:manage`, …); any other key of the reserved ' +
  '`sys` feature is refused (`validation.failed`, 422).'

const versioned =
  'A role carries a `version`, which is also its `ETag`: it counts the changes made to the ' +
  'role, from 1.'

const ifMatch = (required: boolean) => ({
  name: 'If-Match',
  in: 'header' as const,
  required,
  description:
    'The role’s version, quoted, as its `ETag` gave it: `"3"`. A role that is no longer at ' +
    'that version is not written (`precondition.failed`, 412; `params.version` is the ' +
    'current one).' +
    (required ? '' : ' Left out, the role is deleted whatever its version.'),
  schema: { type: 'string' as const },
})

router.get(
  '/',
  describeRoute({
    operationId: 'listOrganizationRoles',
    tags: ['Organizations'],
    summary: 'List organization roles',
    description:
      'The environment’s roles: the built-in `admin` and `member` first, then the custom ' +
      `roles by key. Roles are shared by all the environment’s organizations. ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The roles.', content: json(OrganizationRoleListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) =>
    c.json(OrganizationRoleListSchema.parse(await Roles.list(c.get('deps'), c.get('tenant'))))
)

router.post(
  '/',
  describeRoute({
    operationId: 'createOrganizationRole',
    tags: ['Organizations'],
    summary: 'Define a custom role',
    description:
      'Defines a role of the environment: a key (`^[a-z][a-z0-9_]{0,31}$`, unique, and ' +
      'never `admin` or `member`), a name and a set of permissions. ' +
      `${permissions} An environment has at most ${MAX_CUSTOM_ROLES} custom roles ` +
      '(`organization.role_limit`, 409). A key that is taken, by a custom role or a built-in ' +
      `one, is \`organization.role_exists\` (409). ${versioned} ${disabled}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The role, at version 1.', content: json(OrganizationRoleSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateOrganizationRoleRequestSchema, validationHook),
  async (c) => {
    const role = await Roles.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    c.header('ETag', Settings.etag(role.version))
    return c.json(OrganizationRoleSchema.parse(role), 201)
  }
)

router.get(
  '/:key',
  describeRoute({
    operationId: 'getOrganizationRole',
    tags: ['Organizations'],
    summary: 'Get an organization role',
    description: `One role of the environment, by its key. ${versioned} ${disabled}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The role.', content: json(OrganizationRoleSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', RoleKeyParamSchema, validationHook),
  async (c) => {
    const role = await Roles.get(c.get('deps'), c.get('tenant'), c.req.valid('param').key)
    c.header('ETag', Settings.etag(role.version))
    return c.json(OrganizationRoleSchema.parse(role))
  }
)

router.patch(
  '/:key',
  describeRoute({
    operationId: 'updateOrganizationRole',
    tags: ['Organizations'],
    summary: 'Change a custom role',
    description:
      'Renames a custom role or replaces its permissions: the set sent is the whole set. The ' +
      'key cannot be changed. `admin` and `member` cannot be changed ' +
      '(`organization.role_built_in`, 409). `If-Match` must carry the version that was read. ' +
      `${permissions} Members who hold the role carry the new permissions from their next ` +
      'refresh, within the access token’s lifetime; nothing is copied into a membership. ' +
      'A change that takes `org:sys:memberships:manage` from a role is refused ' +
      '(`organization.last_manager`, 409) while some organization has no other member who ' +
      'holds it. The audit entry names the fields that changed and a count of permissions, ' +
      'and carries `weakened: true` when the role gained a permission. ' +
      `${versioned} ${disabled}`,
    security: openapi.security.admin,
    parameters: [ifMatch(true)],
    responses: {
      200: { description: 'The role as it is now.', content: json(OrganizationRoleSchema) },
      409: openapi.responses[409],
      412: openapi.responses[412],
      413: openapi.responses[413],
      422: openapi.responses[422],
      428: openapi.responses[428],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', RoleKeyParamSchema, validationHook),
  validator('json', UpdateOrganizationRoleRequestSchema, validationHook),
  async (c) => {
    const role = await Roles.update(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').key,
      Settings.expectedRevision(c.req.header('if-match')),
      c.req.valid('json'),
      adminActor(c)
    )
    c.header('ETag', Settings.etag(role.version))
    return c.json(OrganizationRoleSchema.parse(role))
  }
)

router.delete(
  '/:key',
  describeRoute({
    operationId: 'deleteOrganizationRole',
    tags: ['Organizations'],
    summary: 'Delete a custom role',
    description:
      'Deletes a custom role that no member holds, in any organization of the environment: ' +
      'one that is still assigned is refused (`organization.role_in_use`, 409) and nothing is ' +
      'changed. `admin` and `member` cannot be deleted (`organization.role_built_in`, 409). ' +
      `${disabled}`,
    security: openapi.security.admin,
    parameters: [ifMatch(false)],
    responses: {
      204: { description: 'Deleted.' },
      409: openapi.responses[409],
      412: openapi.responses[412],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', RoleKeyParamSchema, validationHook),
  async (c) => {
    const header = c.req.header('if-match')
    await Roles.remove(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').key,
      header === undefined ? null : Settings.expectedRevision(header),
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
