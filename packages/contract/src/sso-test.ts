import { z } from 'zod'

/**
 * Why a test sign-in of an SSO connection failed, each with a sentence for the person setting
 * the connection up (ADR 0067). **This is the one place a verifier's reason is shown:** a real
 * sign-in answers `sso.provider_error` for every refusal and only logs the reason.
 */
export const SSO_TEST_REASONS = {
  wrong_audience:
    'The response was meant for a different audience. Set the identity provider’s audience (SP entity id) or client id to the values shown for this connection.',
  wrong_issuer:
    'The response came from a different issuer than the one saved. Check the identity provider’s entity id or issuer.',
  wrong_recipient:
    'The response was addressed to another address than this connection’s assertion consumer service URL. Copy the ACS URL shown here into the identity provider.',
  unsigned_assertion:
    'The assertion was not signed. Turn on assertion signing in the identity provider.',
  signature_invalid:
    'The signature did not match the saved certificate. Upload the certificate the identity provider currently signs with.',
  signature_algorithm:
    'The response was signed with an algorithm that is not accepted. Use RSA with SHA-256.',
  certificate_not_trusted:
    'The response was signed with a key that is not one of the saved certificates.',
  certificate_expired:
    'The saved signing certificate has expired. Upload the identity provider’s new certificate.',
  assertion_expired:
    'The response had already expired. Check that the identity provider’s clock is right and that you finish the sign-in promptly.',
  clock_skew:
    'The response is not valid yet. The identity provider’s clock is ahead of this server’s; correct it.',
  response_not_to_this_request:
    'The response did not answer this test’s sign-in request (it was started at the identity provider, or is for another request).',
  replayed: 'This response was already used once.',
  idp_refused: 'The identity provider reported that the sign-in failed.',
  encrypted_assertion:
    'The assertion was encrypted, which is not supported. Turn off assertion encryption.',
  malformed_response:
    'The response could not be read or did not have the shape required (one signed assertion with a subject and conditions).',
  discovery_failed:
    'The identity provider’s configuration could not be read, or names an address that is not https.',
  token_exchange_failed:
    'The identity provider did not accept the code. Check the client id and the client secret.',
  no_id_token: 'The identity provider’s answer held no ID token.',
  id_token_invalid: 'The ID token could not be verified.',
  email_missing: 'The identity provider sent no email address for the person.',
  email_outside_domains:
    'The email address is not on one of the connection’s verified domains, so it would be refused.',
} as const

/** One of {@link SSO_TEST_REASONS}' codes. */
export type SsoTestReason = keyof typeof SSO_TEST_REASONS

const REASON_CODES = Object.keys(SSO_TEST_REASONS) as [SsoTestReason, ...SsoTestReason[]]

/** Starts a test sign-in: where the browser returns to (an address the environment allows). */
export const SsoTestStartRequestSchema = z
  .object({ redirectUrl: z.string().max(2048) })
  .meta({ ref: 'SsoTestStartRequest' })

/** A started test: send the browser to `authorizationUrl`; it returns with `#tula_test=<testId>`. */
export const SsoTestStartSchema = z
  .object({ testId: z.uuid(), authorizationUrl: z.string() })
  .meta({ ref: 'SsoTestStart' })

/**
 * What a test sign-in found. It holds names and values the provider sent, never the raw
 * assertion, a token or a signature.
 */
export const SsoTestResultSchema = z
  .object({
    testId: z.uuid(),
    status: z.enum(['pending', 'passed', 'failed']),
    reason: z.enum(REASON_CODES).nullable(),
    message: z.string().nullable(),
    attributes: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
    groups: z.array(z.string()),
    mapped: z
      .object({
        email: z.string().nullable(),
        givenName: z.string().nullable(),
        familyName: z.string().nullable(),
        emailOnVerifiedDomain: z.boolean(),
      })
      .nullable(),
  })
  .meta({ ref: 'SsoTestResult' })

/** The connection and test ids of a test route's path. */
export const SsoTestIdParamSchema = z.object({ id: z.uuid(), testId: z.uuid() })

/** The body that starts a test. */
export type SsoTestStartRequest = z.infer<typeof SsoTestStartRequestSchema>
/** A started test. */
export type SsoTestStart = z.infer<typeof SsoTestStartSchema>
/** A test's result. */
export type SsoTestResult = z.infer<typeof SsoTestResultSchema>
