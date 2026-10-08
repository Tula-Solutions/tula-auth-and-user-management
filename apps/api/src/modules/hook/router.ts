import {
  HOOK_DEFAULT_DEADLINE_MS,
  HOOK_MAX_DEADLINE_MS,
  HOOK_MIN_DEADLINE_MS,
} from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Hooks from '~/modules/hook/service'
import * as openapi from '~/openapi'
import {
  CreatedHookSchema,
  CreateHookRequestSchema,
  HookIdParamSchema,
  HookListSchema,
  HookSchema,
  UpdateHookRequestSchema,
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

const refusedAddress =
  'An address the server may not call is refused with `hook.url_not_allowed` (422): it must ' +
  'be `https`, carry no credentials, and its host must resolve to public addresses only. ' +
  '`params.reason` is a fixed word for the rule that refused it, never the address.'

const deadline =
  `\`deadlineMs\` is how long the server waits for the answer: ${HOOK_DEFAULT_DEADLINE_MS} ` +
  `unless given, at least ${HOOK_MIN_DEADLINE_MS} and never more than ${HOOK_MAX_DEADLINE_MS}.`

const weakening =
  'Switching a hook off, removing one that is on, and `failureMode: "allow"` (a sign-up is ' +
  'let through when the hook cannot be asked or does not answer as the contract says) each ' +
  'remove a check: the audit entry of such a change carries `weakened: true`.'

router.get(
  '/',
  describeRoute({
    operationId: 'listHooks',
    tags: ['Hooks'],
    summary: 'List hooks',
    description:
      'The environment’s hooks, oldest first: at most one per point. Each says when a call ' +
      'of it last failed (`lastFailedAt`) and why, in a fixed word (`lastFailureReason`). A ' +
      'signing secret is never returned here: it is shown once, when its hook is registered.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The hooks.', content: json(HookListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Hooks.list(c.get('deps'), c.get('tenant'))
    return c.json(HookListSchema.parse({ data }))
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createHook',
    tags: ['Hooks'],
    summary: 'Register a hook',
    description:
      'Registers an address the server asks before it acts at `point`. For `before_sign_up` ' +
      'the question (`HookBeforeSignUpQuestion`) is posted, signed like a webhook delivery ' +
      '(Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`), when a ' +
      'sign-up is about to create an account, and the answer (`HookAnswer`) allows or denies ' +
      'it. It is not asked when an administrator creates a user. The server generates the ' +
      'signing secret (`whsec_…`) and returns it in this response only; it is stored ' +
      'encrypted and cannot be read again. An environment has one hook per point: a second ' +
      `is refused with \`resource.conflict\` (409). ${deadline} ${weakening} ${refusedAddress}`,
    security: openapi.security.admin,
    responses: {
      201: {
        description: 'The new hook, including its signing secret.',
        content: json(CreatedHookSchema),
      },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateHookRequestSchema, validationHook),
  async (c) => {
    const created = await Hooks.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    // Never let an intermediary cache the one response that contains the secret.
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedHookSchema.parse(created), 201)
  }
)

router.get(
  '/:id',
  describeRoute({
    operationId: 'getHook',
    tags: ['Hooks'],
    summary: 'Get a hook',
    description: 'One hook of the environment. Never its signing secret.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The hook.', content: json(HookSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', HookIdParamSchema, validationHook),
  async (c) => {
    const hook = await Hooks.get(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
    return c.json(HookSchema.parse(hook))
  }
)

router.patch(
  '/:id',
  describeRoute({
    operationId: 'updateHook',
    tags: ['Hooks'],
    summary: 'Change a hook',
    description:
      'Changes the address, the deadline, the failure mode or whether the hook is on; a field ' +
      'left out keeps its value. A hook that is off is not asked: what it guards happens as ' +
      'if there were none. The point and the signing secret cannot be changed here. Recorded ' +
      'in the audit log by the names of the fields that changed, never their values. A hook ' +
      'that someone else changed meanwhile is not written over (`resource.conflict`, 409). ' +
      `${deadline} ${weakening} ${refusedAddress}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The hook as it is now.', content: json(HookSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', HookIdParamSchema, validationHook),
  validator('json', UpdateHookRequestSchema, validationHook),
  async (c) => {
    const updated = await Hooks.update(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(HookSchema.parse(updated))
  }
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'deleteHook',
    tags: ['Hooks'],
    summary: 'Remove a hook',
    description:
      'Removes the hook and its signing secret: it is asked no more, and what it guarded ' +
      `happens as if there had been none. ${weakening}`,
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', HookIdParamSchema, validationHook),
  async (c) => {
    await Hooks.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').id, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
