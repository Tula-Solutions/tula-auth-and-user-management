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
 *
 * `claims` checks what a JWT in the body says: each key is the dot path of a token
 * (`session.accessToken`), each value is matched, as `body` is, against the token's decoded
 * payload. The signature is not verified: a scenario states what a client reads from the token.
 *
 * `headers` checks response headers by name, each value matched as a `body` value is.
 */
export const ExpectSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown().optional(),
    /** Strings the raw response must not contain anywhere, e.g. `{{email}}` in an audit entry. */
    bodyExcludes: z.array(z.string().min(1)).optional(),
    /**
     * Claims of JWTs in the response, by the token's dot path in the body:
     * `{ "session.accessToken": { "amr": { "$set": ["pwd", "otp", "mfa"] }, "auth_time": "$any" } }`.
     * `{ "$set": [...] }` matches an array with exactly those members in any order.
     */
    claims: z.record(z.string(), z.unknown()).optional(),
    /**
     * Response headers, by name (case does not matter), each matched like a `body` value
     * against the header's text: `{ "x-tula-can-still-sign-in": "false" }`. A header the
     * response does not have is absent (`"$absent"` matches it, anything else does not).
     */
    headers: z.record(z.string().regex(HEADER_NAME), z.unknown()).optional(),
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
    /**
     * Variables to set from a cookie the response sets (`Set-Cookie`): the first one whose
     * name contains `match` and whose value is not empty. `pair` receives `name=value`, what a
     * browser sends back in `Cookie`; `value` receives the value alone. Cookie names depend on
     * the deployment (the environment id, a `__Host-` prefix over https), hence the match by
     * part of the name: `{ "match": "tula_session_", "pair": "cookie", "value": "token" }`.
     */
    captureCookie: z
      .object({
        match: z.string().min(1),
        pair: z.string().min(1).optional(),
        value: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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

/**
 * Read the sign-in link from the newest email to an address that carries a code, and take it
 * apart the way the page it leads to does: the link token and the attempt id are in the URL's
 * fragment (`#tula_link=…&tula_attempt=…`), never in its query.
 */
export const EmailLinkStepSchema = z
  .object({
    name: z.string().min(1),
    emailLink: z.object({
      to: z.string(),
      /** Variable to store the link token in. */
      captureToken: z.string(),
      /** Variable to store the attempt id the link names in. */
      captureAttempt: z.string().optional(),
      /**
       * What the link must be once its fragment is removed: exactly this URL. Shows that the
       * link leads to the redirect URL that was asked for and carries nothing in its query.
       */
      url: z.string().optional(),
    }),
  })
  .strict()
  .meta({ ref: 'ConformanceEmailLinkStep' })

/**
 * Compute the code an authenticator app shows now for a secret the API returned (RFC 6238:
 * HMAC-SHA-1, six digits, 30-second steps). "Now" is the target's clock: the wall clock against
 * a live server, the test clock (which `wait` steps advance) in process.
 *
 * A server accepts a time step once, so two uses of one secret need a `wait` of at least one
 * step (`30s`) between them.
 */
export const TotpStepSchema = z
  .object({
    name: z.string().min(1),
    totp: z.object({
      /** The Base32 secret, e.g. `{{secret}}` captured from the enrolment. */
      secret: z.string(),
      /** Variable to store the code in. */
      capture: z.string(),
      /** Variable to store a code that is guaranteed to be wrong in. */
      captureWrong: z.string().optional(),
    }),
  })
  .strict()
  .meta({ ref: 'ConformanceTotpStep' })

/**
 * Play the user's authenticator in a WebAuthn ceremony (ADR 0027): take the options a server
 * issued and produce what a browser would send back.
 *
 * A runner needs a **software authenticator** for this step: one that makes a P-256 (ES256)
 * discoverable credential and answers
 *
 * - `create` with a `RegistrationResponseJSON`: client data of type `webauthn.create` for the
 *   options' challenge and this step's `origin`; an attestation object of format `none` whose
 *   authenticator data has the SHA-256 of the options' `rp.id`, the user-present flag, the
 *   user-verified flag (unless `userVerified` is `false`), the attested credential data, and
 *   the backup-eligible and backed-up flags when `synced` is set;
 * - `get` with an `AuthenticationResponseJSON`: client data of type `webauthn.get`,
 *   authenticator data with the SHA-256 of the options' `rpId`, the flags as above and the
 *   signature counter `counter` (default 0), an ASN.1 DER ECDSA signature over the
 *   authenticator data and the SHA-256 of the client data, and the user handle the credential
 *   was created with.
 *
 * Authenticators are named and live for one scenario run: a credential made by `phone` in one
 * step is the one `phone` signs with later. Exactly one of `create` and `get` is given: a
 * variable holding the options as JSON text (stored by a request step's `captureJson`). The
 * response is stored as JSON text in `capture`; send it with `{ "$json": "{{name}}" }`.
 */
export const PasskeyStepSchema = z
  .object({
    name: z.string().min(1),
    passkey: z
      .object({
        /** Which authenticator acts. Created on first use. */
        authenticator: z.string().min(1),
        /** The creation options, as JSON text: `{{creationOptions}}`. */
        create: z.string().optional(),
        /** The request options, as JSON text: `{{requestOptions}}`. */
        get: z.string().optional(),
        /** The page's origin, written into the client data. */
        origin: z.string(),
        /** Variable to store the response's JSON text in. */
        capture: z.string(),
        /** `false`: the authenticator did not verify the user. */
        userVerified: z.boolean().optional(),
        /** The signature counter to report. Default 0 (an authenticator that keeps none). */
        counter: z.number().int().min(0).optional(),
        /** Report the credential as backup-eligible and backed up. */
        synced: z.boolean().optional(),
      })
      .strict()
      .refine((passkey) => (passkey.create === undefined) !== (passkey.get === undefined), {
        message: 'a passkey step takes either `create` or `get`',
      }),
  })
  .strict()
  .meta({ ref: 'ConformancePasskeyStep' })

/**
 * Play the user at the OAuth provider (ADR 0026): take the authorization URL a sign-in start
 * answered, "consent" at the provider, follow the provider back to the API's callback, and read
 * what the callback sends the app's page in its URL fragment.
 *
 * The provider is the server's **mock provider** (`OAUTH_MOCK_PROVIDER=true`, local tier only),
 * whose consent endpoint is the authorization URL's own path. The runner posts the URL's query
 * parameters and the consent fields below to it as a form, follows nothing automatically, and
 * calls the callback the answer's `Location` names. Every request goes to the target's base
 * URL: only the path and query of the URLs are used.
 *
 * With `callback` instead of `authorizationUrl`, the step replays a callback captured earlier
 * (`captureCallback`) without visiting the provider again.
 */
export const OAuthStepSchema = z
  .object({
    name: z.string().min(1),
    oauth: z
      .object({
        /** The `authorizationUrl` of a start, e.g. `{{authorizationUrl}}`. */
        authorizationUrl: z.string().optional(),
        /** A callback path and query captured by an earlier step, to replay. */
        callback: z.string().optional(),
        /** The address the provider reports. */
        email: z.string().optional(),
        /** The provider's id for the account. Derived from the address when left out. */
        subject: z.string().optional(),
        /** The provider reports the address as unverified. */
        unverified: z.boolean().optional(),
        /** The user cancels at the provider. */
        deny: z.boolean().optional(),
        /** Variable that receives the ticket. The step fails when the callback sent an error. */
        captureTicket: z.string().optional(),
        /** Variable that receives the attempt id. */
        captureAttempt: z.string().optional(),
        /**
         * The contract error code the callback must send the app's page instead of a ticket,
         * e.g. `oauth.state_invalid`. The step fails on a ticket or on another code.
         */
        expectError: z.string().optional(),
        /** Variable that receives the callback's path and query, for a later replay. */
        captureCallback: z.string().optional(),
      })
      .strict()
      .refine(
        (oauth) => (oauth.authorizationUrl === undefined) !== (oauth.callback === undefined),
        {
          message: 'an oauth step takes either `authorizationUrl` or `callback`',
        }
      ),
  })
  .strict()
  .meta({ ref: 'ConformanceOAuthStep' })

/**
 * Play the operator's backend that receives webhooks (ADR 0034): an HTTP listener the runner
 * owns, which a scenario registers as an endpoint and then asks what arrived.
 *
 * Receivers are named and live for one scenario run. A step does exactly one of two things:
 *
 * - `captureUrl` starts the receiver (on first use) and stores the URL the server is to be
 *   given for it, to send as the `url` of `POST /v1/admin/webhook-endpoints`. With `answers`
 *   the receiver answers its next deliveries with those statuses, one each, in order (a
 *   backend that fails and then recovers: `[500]`), and `204` again after them;
 * - `expect` takes the next delivery that arrived there (of the event `type`, when one is
 *   named) and checks it: a `POST` of JSON with the Standard Webhooks headers `webhook-id`,
 *   `webhook-timestamp` (whole seconds, within five minutes of the target's clock) and
 *   `webhook-signature`, of which one `v1,<base64>` entry is the HMAC-SHA256 of
 *   `<id>.<timestamp>.<body>` under `secret` (the `whsec_…` value the registration returned);
 *   a body that is an event of the contract whose `id` is the `webhook-id`; and `body`,
 *   matched as a request step's `expect.body` is.
 *
 * A runner needs a listener the server under test can reach, which is why a scenario with
 * such a step sets `needsWebhookReceiver` and is skipped by a target that has none. Where the
 * target can run a delivery round itself (in process) the step asks for one and looks at once;
 * against a live server it waits for the server's own worker, up to the target's timeout.
 *
 * The receiver answers a delivery `204` with no body, unless `answers` said otherwise for it.
 * A scenario that needs the server's retry to be due uses a `wait` step: a real sleep against
 * a live server, the test clock in process.
 */
export const WebhookStepSchema = z
  .object({
    name: z.string().min(1),
    webhook: z
      .object({
        /** Which receiver. Started on first use. */
        receiver: z.string().min(1),
        /** Variable that receives the URL to register as the endpoint's address. */
        captureUrl: z.string().min(1).optional(),
        /**
         * With `captureUrl`: the HTTP statuses the receiver answers its next deliveries with,
         * one each, in order. After them it answers `204` again.
         */
        answers: z.array(z.number().int().min(200).max(599)).min(1).max(16).optional(),
        /** What the next delivery must be. */
        expect: z
          .object({
            /** The endpoint's signing secret, e.g. `{{secret}}` captured from its registration. */
            secret: z.string(),
            /** Take the next delivery of this event type; without it, the next delivery. */
            type: z.string().optional(),
            /** Matched against the delivered event like a response body: a subset. */
            body: z.unknown().optional(),
            /** Variable that receives the event's id (the `webhook-id` header). */
            captureId: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((webhook) => (webhook.captureUrl === undefined) !== (webhook.expect === undefined), {
        message: 'a webhook step takes either `captureUrl` or `expect`',
      })
      .refine((webhook) => webhook.answers === undefined || webhook.captureUrl !== undefined, {
        message: '`answers` belongs to the step that starts the receiver (`captureUrl`)',
      }),
  })
  .strict()
  .meta({ ref: 'ConformanceWebhookStep' })

/** Let time pass, e.g. past the refresh reuse grace period. */
export const WaitStepSchema = z
  .object({ name: z.string().min(1), wait: DurationSchema })
  .strict()
  .meta({ ref: 'ConformanceWaitStep' })

/** One step of a scenario. */
export const StepSchema = z
  .union([
    RequestStepSchema,
    EmailCodeStepSchema,
    EmailLinkStepSchema,
    TotpStepSchema,
    OAuthStepSchema,
    PasskeyStepSchema,
    WebhookStepSchema,
    WaitStepSchema,
  ])
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
    /**
     * `true` when a step uses a webhook receiver: the server has to be able to reach a
     * listener the runner starts, so a target that offers none skips the scenario.
     */
    needsWebhookReceiver: z.boolean().optional(),
    variables: z.record(z.string(), VariableSchema).optional(),
    steps: z.array(StepSchema).min(1),
    /**
     * Steps that run after `steps`, **whether or not they passed**: how a scenario that changes
     * the environment's settings puts them back even when it fails half-way, so that it cannot
     * break the scenarios after it. They stop at their own first failure, which fails the
     * scenario.
     */
    cleanup: z.array(StepSchema).min(1).optional(),
  })
  .strict()
  // Without the flag the runner cannot know to skip the scenario when no secret key is given,
  // and would send the request without one.
  .refine(
    (scenario) =>
      scenario.needsSecretKey === true ||
      [...scenario.steps, ...(scenario.cleanup ?? [])].every(
        (step) => !('request' in step) || step.request.auth !== 'secret'
      ),
    { message: 'a scenario with an `auth: "secret"` step must set `needsSecretKey: true`' }
  )
  // The same for the receiver: without the flag a target that cannot be reached would run the
  // scenario and fail it, instead of saying it was not run.
  .refine(
    (scenario) =>
      scenario.needsWebhookReceiver === true ||
      [...scenario.steps, ...(scenario.cleanup ?? [])].every((step) => !('webhook' in step)),
    { message: 'a scenario with a `webhook` step must set `needsWebhookReceiver: true`' }
  )
  .meta({ ref: 'ConformanceScenario' })

/** A request to send. */
export type ScenarioRequest = z.infer<typeof RequestSchema>
/** A step. */
export type Step = z.infer<typeof StepSchema>
/** A scenario. */
export type Scenario = z.infer<typeof ScenarioSchema>
