import { DurationSchema } from '@tula/contract'
import { z } from 'zod'

/** An HTTP header name. */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/

/** Headers the runner sets from other fields of a request; `headers` may not replace them. */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'content-type',
  'user-agent',
  'x-forwarded-for',
  'x-tula-attempt',
  'x-tula-client',
  'x-tula-publishable-key',
])

/** Which credential a request carries. */
export const AuthSchema = z.enum(['publishable', 'secret', 'none']).meta({ ref: 'ConformanceAuth' })

/**
 * One HTTP request. Every string may contain `{{name}}` placeholders, filled from the
 * scenario's variables and from values captured by earlier steps.
 */
export const RequestSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** Path and query, e.g. `/v1/client/sign-ins/{{attemptId}}/password`. */
    path: z.string().startsWith('/'),
    /**
     * `publishable` (default) sends the publishable key header, `secret` the secret key as a
     * bearer token, `none` neither.
     */
    auth: AuthSchema.default('publishable'),
    /** An access token to send as `Authorization: Bearer …` alongside the publishable key. */
    accessToken: z.string().optional(),
    /** Value of `x-tula-client`. Scenarios use a native kind so tokens arrive in the body. */
    client: z.enum(['web', 'ios', 'android', 'server']).optional(),
    /**
     * The secret of the attempt the request continues, sent as `x-tula-attempt`: the
     * `attemptSecret` a start step captured, e.g. `{{signInSecret}}`. Every call on an attempt
     * after its start needs it; leave it out (or send a wrong one) to show the refusal.
     */
    attempt: z.string().optional(),
    /**
     * JSON body. An object of the form `{ "$json": "{{name}}" }`, anywhere in it, is replaced
     * by the JSON value a `captureJson` stored in that variable, so a document read in one step
     * can be sent back whole in a later one.
     */
    body: z.unknown().optional(),
    /**
     * Extra request headers, e.g. `{ "If-Match": "{{etag}}" }` or `{ "Origin": "…" }`. The
     * headers the runner sets itself (keys, client kind, attempt secret, content type, forwarded
     * address) cannot be set here.
     */
    headers: z.record(z.string().regex(HEADER_NAME), z.string()).optional(),
    /**
     * Which API instance receives the request, for behaviour that must hold across instances of
     * one deployment (a session ended on one is refused by the other). `second` goes to the
     * target's second instance; a target with only one sends it to that one, so the scenario
     * still runs, and passes, against a single server. Defaults to `first`.
     */
    instance: z.enum(['first', 'second']).optional(),
  })
  .refine((request) => !(request.auth === 'secret' && request.accessToken !== undefined), {
    message: 'a request carries the secret key or an access token, not both',
  })
  .refine(
    (request) =>
      Object.keys(request.headers ?? {}).every((name) => !RESERVED_HEADERS.has(name.toLowerCase())),
    { message: 'a request cannot override a header the runner sets itself', path: ['headers'] }
  )
  .meta({ ref: 'ConformanceRequest' })

/**
 * What the response must look like.
 *
 * `body` is matched as a **subset**: every key given must match, extra keys in the response are
 * ignored. A value is compared literally, except:
 * - `"$any"`: present and not null
 * - `"$absent"`: missing or null
 * - `{ "$not": value }`: anything but `value`
 * - `{ "$matches": "regex" }`: a string matching the pattern
 *
 * `$not` and `$matches` need the value to be present.
 */
export const ExpectSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown().optional(),
    /** Strings the raw response must not contain anywhere, e.g. `{{email}}` in an audit entry. */
    bodyExcludes: z.array(z.string().min(1)).optional(),
  })
  .meta({ ref: 'ConformanceExpect' })

/** Send a request and check the response. */
export const RequestStepSchema = z
  .object({
    /** What this step shows, for the report. */
    name: z.string().min(1),
    request: RequestSchema,
    expect: ExpectSchema,
    /** Send the request this many times; every response must match. Defaults to 1. */
    times: z.number().int().min(1).max(100).optional(),
    /** Variables to set from the response body: `{ "attemptId": "id", "token": "session.refreshToken" }`. */
    capture: z.record(z.string(), z.string()).optional(),
    /** Variables to set from response headers: `{ "etag": "ETag" }`. */
    captureHeaders: z.record(z.string(), z.string().regex(HEADER_NAME)).optional(),
    /**
     * Variables to set to the JSON text of any value in the response body, objects included:
     * `{ "original": "settings" }`. Send it back with `{ "$json": "{{original}}" }` in a body.
     */
    captureJson: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .meta({ ref: 'ConformanceRequestStep' })

/** Read the 6-digit code from the newest email sent to an address. */
export const EmailCodeStepSchema = z
  .object({
    name: z.string().min(1),
    emailCode: z.object({
      to: z.string(),
      /** Variable to store the code in. */
      capture: z.string(),
      /** Variable to store a code that is guaranteed to be wrong in. */
      captureWrong: z.string().optional(),
    }),
  })
  .strict()
  .meta({ ref: 'ConformanceEmailCodeStep' })

/** Let time pass, e.g. past the refresh reuse grace period. */
export const WaitStepSchema = z
  .object({ name: z.string().min(1), wait: DurationSchema })
  .strict()
  .meta({ ref: 'ConformanceWaitStep' })

/** One step of a scenario. */
export const StepSchema = z
  .union([RequestStepSchema, EmailCodeStepSchema, WaitStepSchema])
  .meta({ ref: 'ConformanceStep' })

/**
 * A variable's starting value: a literal, or a value generated fresh for each run. `email` is a
 * unique address; `password` is a long random one that meets every built-in policy and is in no
 * breach list.
 */
export const VariableSchema = z
  .union([z.string(), z.object({ generate: z.enum(['email', 'password']) }).strict()])
  .meta({ ref: 'ConformanceVariable' })

/**
 * A conformance scenario: a sequence of HTTP exchanges every Tula server, and every SDK talking
 * to one, must get right. Scenarios are plain JSON so that Swift, Kotlin and TypeScript test
 * suites can all run the same files.
 */
export const ScenarioSchema = z
  .object({
    /** JSON Schema reference, for editors. */
    $schema: z.string().optional(),
    name: z.string().min(1),
    description: z.string().min(1),
    /** `true` when a step uses the secret key. */
    needsSecretKey: z.boolean().optional(),
    variables: z.record(z.string(), VariableSchema).optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  // Without the flag the runner cannot know to skip the scenario when no secret key is given,
  // and would send the request without one.
  .refine(
    (scenario) =>
      scenario.needsSecretKey === true ||
      scenario.steps.every((step) => !('request' in step) || step.request.auth !== 'secret'),
    { message: 'a scenario with an `auth: "secret"` step must set `needsSecretKey: true`' }
  )
  .meta({ ref: 'ConformanceScenario' })

/** A request to send. */
export type ScenarioRequest = z.infer<typeof RequestSchema>
/** A step. */
export type Step = z.infer<typeof StepSchema>
/** A scenario. */
export type Scenario = z.infer<typeof ScenarioSchema>
