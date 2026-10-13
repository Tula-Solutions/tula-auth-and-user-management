import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { adminActor, agentActor } from '~/lib/actor'
import { agentKey } from '~/middleware/agent-key'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as SignInTests from '~/modules/sign-in-test/service'
import * as openapi from '~/openapi'
import { SignInTestReportSchema } from './schema'

// One run, two doors (ADR 0058). An agent key is taken on `/v1/agent/*` and a secret key (or
// the dashboard) on `/v1/admin/*`, by the two middlewares as they are: neither gains an
// exception, and both routes hand the same function the same things.

const router = new Hono<AppEnv>()

const whatARunDoes =
  'Sign a throwaway user up and in through the environment’s real flow, delete it, and ' +
  'answer a report of each step. There is no body. ' +
  '**It changes the environment while it runs**: a user exists for a few seconds, the ' +
  'environment’s hooks are asked and its events are recorded and delivered to its webhook ' +
  'endpoints (`user.created` carries `test: true`). The user’s address is in the reserved ' +
  'domain `test.tula.invalid`, which no account of a person can hold; the email with its ' +
  'code is read inside the server and never sent. The user is deleted whatever a step did; ' +
  '`cleanup` says `failed`, with `userId`, where that deletion did not go through (the ' +
  'server removes such a user later). ' +
  'The answer holds no token, code, secret or address: a step has an outcome (`passed`, ' +
  '`failed`, `not_run`), a duration and, where it did not pass, an error code of the API or ' +
  'a fixed reason. A step that could not be carried out is `not_run`, never `passed`. ' +
  'Allowed only where the environment’s `agents.testSignIn` says so: on by default in a ' +
  'development environment, off in a production one (`auth.forbidden`, `params.reason`: ' +
  '`test_sign_in_disabled`). ' +
  `Limited to ${SignInTests.SIGN_IN_TESTS_PER_KEY_PER_HOUR} an hour per credential, ` +
  `${SignInTests.SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR} an hour per environment and one a ` +
  'minute per environment, so that two never run at once. '

const answers = {
  200: {
    description: 'The report. A test whose steps failed is still a 200.',
    content: { 'application/json': { schema: resolver(SignInTestReportSchema) } },
  },
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

router.post(
  '/agent/sign-in-tests',
  describeRoute({
    operationId: 'runSignInTest',
    tags: ['Sign-in tests'],
    summary: 'Run a sign-in test (agent)',
    description:
      whatARunDoes +
      'This is the one thing an agent key does that is neither a read nor a proposal, and ' +
      'only where the environment allows it. The run, and the deletion of its user, are ' +
      'recorded with the `agent` actor.',
    security: openapi.security.agent,
    responses: {
      ...answers,
      401: openapi.responses[401],
      403: openapi.responses[403],
    },
  }),
  adminRateLimit(),
  agentKey(),
  async (c) => {
    const report = await SignInTests.run(c.get('deps'), c.get('tenant'), agentActor(c), {
      signal: c.req.raw.signal,
    })
    c.header('Cache-Control', 'no-store')
    return c.json(SignInTestReportSchema.parse(report))
  }
)

router.post(
  '/admin/sign-in-tests',
  describeRoute({
    operationId: 'runSignInTestAsAdmin',
    tags: ['Sign-in tests'],
    summary: 'Run a sign-in test',
    description:
      whatARunDoes +
      'With a secret key or a dashboard session; an agent key runs it on ' +
      '`POST /v1/agent/sign-in-tests`. The run, and the deletion of its user, are recorded ' +
      'with the caller as the actor.',
    security: openapi.security.admin,
    responses: { ...answers, ...openapi.adminResponses },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const report = await SignInTests.run(c.get('deps'), c.get('tenant'), adminActor(c), {
      signal: c.req.raw.signal,
    })
    c.header('Cache-Control', 'no-store')
    return c.json(SignInTestReportSchema.parse(report))
  }
)

export default router
