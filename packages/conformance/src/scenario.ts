import {
  DurationSchema,
  durationToMs,
  HookAnswerSchema,
  HookClaimsAnswerSchema,
} from '@tula/contract'
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
     * Send a device-key proof with the request, in the `DPoP` header (device binding). The
     * runner makes a new proof for this request (its method, and its path under the target's
     * public URL), signed by one of the run's software keys.
     *
     * A key is made the first time a run names it and lives as long as the run: **no key is
     * ever written in a scenario file**. Two names are two keys, which is how a scenario shows
     * a proof of the wrong key. To send the very same proof twice (a replay), store it with
     * `capture` and send it again as a header: `"headers": { "DPoP": "{{usedProof}}" }`.
     */
    proof: z
      .object({
        /** The name of the run's key that signs, e.g. `device`. */
        key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
        /**
         * The server's nonce to put in the proof, e.g. `{{nonce}}` (read from an answer's
         * `DPoP-Nonce` header with `captureHeaders`). Left out, the proof has none.
         */
        nonce: z.string().optional(),
        /** Variable to store the proof in, to send it a second time. */
        capture: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
  .refine(
    (request) =>
      request.proof === undefined ||
      Object.keys(request.headers ?? {}).every((name) => name.toLowerCase() !== 'dpop'),
    { message: 'a request carries a new proof or a DPoP header, not both', path: ['proof'] }
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
 * Play a provider's native SDK: have the server's mock OAuth provider mint the ID token an
 * app would have been handed, and keep it in a variable (ADR 0045).
 *
 * The token is what the step says, right or wrong on purpose: another app's audience, a
 * nonce that is not the attempt's, one that has expired. It is minted by the server's mock
 * provider (`OAUTH_MOCK_PROVIDER=true`), so the scenario needs a server with it, as the
 * `oauth` steps do. It is never written into a scenario file or a result.
 *
 * `nonceSha256` is for Apple (ADR 0047), whose token must carry the lowercase hexadecimal
 * SHA-256 of the server's nonce: the **runner** takes the hash, as an iOS app does before it
 * hands the value to the system's sheet, and asks for a token whose `nonce` is that. A step
 * has `nonce` or `nonceSha256`, never both.
 */
export const IdTokenStepSchema = z
  .object({
    name: z.string().min(1),
    idToken: z
      .object({
        /** The provider the token is from. */
        provider: z.string().default('google'),
        /** The token's `aud`: the client id it was issued for. */
        audience: z.string(),
        /** The token's `azp`: the app that asked for it. Left out, the token has none. */
        authorizedParty: z.string().optional(),
        /** The token's `nonce`, e.g. `{{nonce}}` of a start. Left out, the token has none. */
        nonce: z.string().optional(),
        /**
         * The string whose lowercase hexadecimal SHA-256 (of its UTF-8 bytes) is the token's
         * `nonce`, e.g. `{{nonce}}` of a start: what an app passes to Sign in with Apple.
         */
        nonceSha256: z.string().optional(),
        /** The address the provider reports. */
        email: z.string().optional(),
        /** The provider's id for the account. Derived from the address when left out. */
        subject: z.string().optional(),
        /** The provider reports the address as unverified. */
        unverified: z.boolean().optional(),
        /** The account's given name. */
        givenName: z.string().optional(),
        /** The account's family name. */
        familyName: z.string().optional(),
        /** The token expired before the app presents it. */
        expired: z.boolean().optional(),
        /** Variable to store the token in. */
        capture: z.string(),
      })
      .strict()
      .refine((step) => step.nonce === undefined || step.nonceSha256 === undefined, {
        message: 'a token has one nonce: give nonce or nonceSha256, not both',
      }),
  })
  .strict()
  .meta({ ref: 'ConformanceIdTokenStep' })

/**
 * Read the 6-digit code from the newest text message sent to a phone number.
 *
 * The message is read from the server's development SMS inbox (`SMS_PROVIDER=dev`, the
 * `local` tier only), so a scenario with such a step sets `needsSmsInbox` and is skipped by
 * a target that has none.
 *
 * `not` names a code read earlier from the same number: the step then waits for a message
 * with another code. A server may send a message after it has answered the request that
 * asked for it (a sign-in code is: ADR 0037), and until it has, the newest message is still
 * the earlier one.
 */
export const SmsCodeStepSchema = z
  .object({
    name: z.string().min(1),
    smsCode: z
      .object({
        /** The number in E.164 form, as the server stored it. */
        to: z.string(),
        /** Variable to store the code in. */
        capture: z.string(),
        /** Variable to store a code that is guaranteed to be wrong in. */
        captureWrong: z.string().optional(),
        /** A code the newest message must no longer hold: an earlier one to the number. */
        not: z.string().optional(),
        /**
         * Strings the message's text must contain, each of them: for an environment's own
         * wording of a text message. Checked after the code is captured, so one can name
         * it (`{{<capture>}}`). The server's own last line names a host only the server
         * knows, which is why a scenario holds the sentence and not the whole text.
         */
        textContains: z.array(z.string().min(1)).optional(),
        /** Strings the message's text must not contain. */
        textExcludes: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: 'ConformanceSmsCodeStep' })

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
 * Read one email as its reader would: find the newest email to an address whose subject
 * contains a marker, and check its subject and its text.
 *
 * For what a subject cannot say: an environment's own wording of a message (its email
 * templates), where the code need not lead the subject, and a notice, which carries no code
 * at all. The checks run in this order: the code is captured first, so `subject` and
 * `textContains` can name it (`{{code}}`).
 */
export const EmailMessageStepSchema = z
  .object({
    name: z.string().min(1),
    emailMessage: z
      .object({
        to: z.string(),
        /** Picks the message: the newest to the address whose subject contains this. */
        subjectContains: z.string().min(1),
        /**
         * Variable to store the message's code in: the one run of exactly six digits in its
         * text. The step fails when the text holds none, or more than one different run.
         */
        captureCode: z.string().optional(),
        /** What the subject must be, exactly. */
        subject: z.string().optional(),
        /** Strings the text part must contain, each of them. */
        textContains: z.array(z.string().min(1)).optional(),
        /** Strings the text part must not contain. */
        textExcludes: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: 'ConformanceEmailMessageStep' })

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
 *   options' challenge and this step's origin (below); an attestation object of format `none` whose
 *   authenticator data has the SHA-256 of the options' `rp.id`, the user-present flag, the
 *   user-verified flag (unless `userVerified` is `false`), the attested credential data, and
 *   the backup-eligible and backed-up flags when `synced` is set;
 * - `get` with an `AuthenticationResponseJSON`: client data of type `webauthn.get`,
 *   authenticator data with the SHA-256 of the options' `rpId`, the flags as above and the
 *   signature counter `counter` (default 0), an ASN.1 DER ECDSA signature over the
 *   authenticator data and the SHA-256 of the client data, and the user handle the credential
 *   was created with.
 *
 * **The origin in the client data** is what the platform would write, and a step gives it in
 * one of two ways, never both:
 *
 * - `origin`: the string itself. A browser's page (`https://app.example.com`); or, for an iOS
 *   app, `https://` and the relying-party id, which is what Apple's API writes for an app
 *   associated with that domain.
 * - `androidCertFingerprint`: the SHA-256 fingerprint of the certificate an Android app is
 *   signed with. The runner derives the origin Credential Manager writes for such an app,
 *   `android:apk-key-hash:` and the fingerprint's 32 bytes as base64url without padding, with
 *   the contract's `androidApkKeyHashOrigin`. A value that is not a fingerprint fails the step.
 *
 * A request that carries a native app's response sends no `Origin` header and names its
 * client kind (`client: 'ios'` or `'android'`).
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
        /**
         * The origin written into the client data: a page's, or for an iOS app `https://` and
         * the relying-party id. Exactly one of this and `androidCertFingerprint`.
         */
        origin: z.string().optional(),
        /**
         * The SHA-256 fingerprint of an Android app's signing certificate: the client data
         * then carries the origin Android derives from it (`android:apk-key-hash:…`).
         */
        androidCertFingerprint: z.string().optional(),
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
      })
      .refine(
        (passkey) =>
          (passkey.origin === undefined) !== (passkey.androidCertFingerprint === undefined),
        { message: 'a passkey step takes either `origin` or `androidCertFingerprint`' }
      ),
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
        /**
         * The address the provider reports. For X and Facebook the mock provider drops it,
         * as neither adapter asks for one.
         */
        email: z.string().optional(),
        /**
         * The provider's id for the account. Derived from the address when left out. For
         * Discord it is a snowflake (a decimal number in a string), and for X and Facebook a
         * decimal number in a string too; the mock provider refuses anything else, as the
         * adapters do.
         */
        subject: z.string().optional(),
        /**
         * Microsoft only: the tenant id (`tid`) of the account, a GUID. Left out, the mock
         * provider uses a tenant the environment's `tenant` accepts.
         */
        tenantId: z.string().optional(),
        /**
         * Microsoft only: the object id (`oid`) of the account, a GUID. Derived from the address
         * when left out. The account is the pair of the two; `subject` is not read.
         */
        objectId: z.string().optional(),
        /**
         * The provider reports the address as unverified. For Microsoft: the token carries no
         * verified-domain claim (`xms_edov`).
         */
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
        /**
         * The URL the callback must send the browser to, compared exactly with everything in
         * front of the fragment: the redirect URL the sign-in started with, be it a web page,
         * an app link or a custom scheme (`com.example.app:/oauth`). The step fails when the
         * callback redirects anywhere else, or adds anything to it.
         */
        expectRedirectTo: z.string().optional(),
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
 *   matched as a request step's `expect.body` is. For a secret rotation (two secrets sign
 *   during its overlap) the expectation can also name a secret that must sign as well
 *   (`alsoSecrets`), secrets that must not (`notSecrets`: one that was replaced and whose
 *   overlap is over), and how many signatures the header holds (`signatures`: 1 or 2).
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
            /**
             * A secret that must sign the delivery as well as `secret`: the other one of a
             * rotation's overlap. One at most: a server never signs with more than two.
             */
            alsoSecrets: z.array(z.string()).min(1).max(1).optional(),
            /**
             * Secrets no entry of the header may be a signature for: what a rotation replaced,
             * once its overlap has ended or was ended early.
             */
            notSecrets: z.array(z.string()).min(1).max(4).optional(),
            /** How many signatures the header holds, exactly: 1, or 2 during an overlap. */
            signatures: z.number().int().min(1).max(2).optional(),
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

/**
 * Play the operator's endpoint that a **hook** asks (ADR 0035): the same listener as a
 * `webhook` step's (a receiver of one name is one listener), scripted to answer a question.
 *
 * A step does one of two things:
 *
 * - With `captureUrl` and/or `answer`: start the receiver (on first use), store the URL to
 *   register as the hook's address, and say how it answers every question from now on: an
 *   answer of the contract (`{ "decision": "allow" }`, `{ "decision": "deny", "code": … }`,
 *   or a claims hook's `{ "claims": { … } }`),
 *   a bare status (`{ "status": 500 }`), or `"hang"` (it never answers, and the server gives
 *   up at the hook's deadline). A receiver that was never given an `answer` answers `204`,
 *   which is no answer of the contract.
 * - With `expect`: take the oldest question that arrived and check it as a receiver must (a
 *   `POST` of JSON, the Standard Webhooks headers, exactly one signature that is right for
 *   `secret`, a timestamp within five minutes, a body that is a question of the contract and
 *   not an event), then match `body` like a response body. `expect: { "nothing": true }`
 *   says no question arrived: the hook was not asked.
 *
 * A hook is asked inside the request that causes it, so a question has arrived (or not) by
 * the time that request's step is over: nothing is waited for. Like a `webhook` step it needs
 * a receiver the server can reach: the scenario sets `needsWebhookReceiver`.
 */
export const HookStepSchema = z
  .object({
    name: z.string().min(1),
    hook: z
      .object({
        /** Which receiver. Started on first use; shared with `webhook` steps of the same name. */
        receiver: z.string().min(1),
        /** Variable that receives the URL to register as the hook's address. */
        captureUrl: z.string().min(1).optional(),
        /** How the receiver answers every question from now on. */
        answer: z
          .union([
            HookAnswerSchema,
            HookClaimsAnswerSchema,
            z.strictObject({ status: z.number().int().min(200).max(599) }),
            z.literal('hang'),
          ])
          .optional(),
        /** What arrived: the next question, or nothing. */
        expect: z
          .union([
            z.strictObject({
              /** The hook's signing secret, e.g. `{{secret}}` captured from its registration. */
              secret: z.string(),
              /** Matched against the question like a response body: a subset. */
              body: z.unknown().optional(),
            }),
            z.strictObject({ nothing: z.literal(true) }),
          ])
          .optional(),
      })
      .strict()
      .refine((hook) => hook.expect === undefined || hook.captureUrl === undefined, {
        message: 'a hook step that checks a question (`expect`) does not start a receiver',
      })
      .refine((hook) => hook.expect === undefined || hook.answer === undefined, {
        message: 'a hook step takes either `expect` or `answer`',
      })
      .refine(
        (hook) =>
          hook.expect !== undefined || hook.captureUrl !== undefined || hook.answer !== undefined,
        { message: 'a hook step takes `captureUrl`, `answer` or `expect`' }
      ),
  })
  .strict()
  .meta({ ref: 'ConformanceHookStep' })

/**
 * The longest `wait` a scenario may ask of a server whose clock cannot be moved: ten minutes.
 * Against a live server a `wait` is a real sleep, so a scenario that needs more time to pass
 * (a day, for a password to expire) sets `needsTestClock` and runs only where the wait moves a
 * clock.
 */
export const MAX_REAL_WAIT_MS = 10 * 60_000

/**
 * Let time pass, e.g. past the refresh reuse grace period. A wait longer than
 * {@link MAX_REAL_WAIT_MS} needs the scenario's `needsTestClock`.
 */
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
    EmailMessageStepSchema,
    SmsCodeStepSchema,
    TotpStepSchema,
    OAuthStepSchema,
    IdTokenStepSchema,
    PasskeyStepSchema,
    WebhookStepSchema,
    HookStepSchema,
    WaitStepSchema,
  ])
  .meta({ ref: 'ConformanceStep' })

/**
 * A variable's starting value: a literal, or a value generated fresh for each run. `email` is a
 * unique address; `password` is a long random one that meets every built-in policy and is in no
 * breach list; `uuid` is a random lower-case GUID (a Microsoft tenant id or object id);
 * `snowflake` is a random decimal number of at most nineteen digits, in a string, with no
 * leading zero (a Discord user id); `phone` is a United States number in E.164 form from the
 * range kept for fiction (`+1 NXX 555 01XX`), so that per-number limits start clean and no
 * real phone is ever named; `phone_fr` is a French mobile number from the range kept for
 * fiction (`+33 6 39 98 XX XX`), for a scenario that needs a second destination;
 * `p256_private_key` is a P-256 private key made for the run, as the PKCS#8 PEM text of a
 * `.p8` file (what an administrator pastes as Sign in with Apple's key), so that no key is
 * ever written in a scenario file.
 */
export const VariableSchema = z
  .union([
    z.string(),
    z
      .object({
        generate: z.enum([
          'email',
          'password',
          'uuid',
          'snowflake',
          'phone',
          'phone_fr',
          'p256_private_key',
        ]),
      })
      .strict(),
  ])
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
    /**
     * `true` when a step reads a text message: the server has to have a development SMS
     * inbox the runner can read, so a target that offers none skips the scenario.
     */
    needsSmsInbox: z.boolean().optional(),
    /**
     * `true` when a step waits longer than {@link MAX_REAL_WAIT_MS}: the scenario runs only
     * against a target whose `wait` moves the clock the server reads, and a live server,
     * where a wait is a real sleep, skips it.
     */
    needsTestClock: z.boolean().optional(),
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
      [...scenario.steps, ...(scenario.cleanup ?? [])].every(
        (step) => !('webhook' in step) && !('hook' in step)
      ),
    { message: 'a scenario with a `webhook` or `hook` step must set `needsWebhookReceiver: true`' }
  )
  // And for the SMS inbox, which only a server in the `local` tier has.
  .refine(
    (scenario) =>
      scenario.needsSmsInbox === true ||
      [...scenario.steps, ...(scenario.cleanup ?? [])].every((step) => !('smsCode' in step)),
    { message: 'a scenario with an `smsCode` step must set `needsSmsInbox: true`' }
  )
  // And for time: without the flag a live run would sleep for as long as the scenario says.
  .refine(
    (scenario) =>
      scenario.needsTestClock === true ||
      [...scenario.steps, ...(scenario.cleanup ?? [])].every(
        (step) => !('wait' in step) || !waitsTooLong(step.wait)
      ),
    { message: 'a scenario that waits longer than ten minutes must set `needsTestClock: true`' }
  )
  .meta({ ref: 'ConformanceScenario' })

/** Whether a `wait` is longer than a live run may sleep. A malformed one is the schema's to report. */
function waitsTooLong(wait: string): boolean {
  return DurationSchema.safeParse(wait).success && durationToMs(wait) > MAX_REAL_WAIT_MS
}

/** A request to send. */
export type ScenarioRequest = z.infer<typeof RequestSchema>
/** A step. */
export type Step = z.infer<typeof StepSchema>
/** A scenario. */
export type Scenario = z.infer<typeof ScenarioSchema>
