import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * Largest the client may be in an application's bundle, minified and gzipped, with its part of
 * the contract included. It is just under 11.0 kB today: 7.7 kB before the emailed code and
 * link (their actions, the link's binding store, the wait for a link and the landing-page
 * handler cost about 2 kB), and 1.3 kB more for two-step verification (fourteen more routes
 * in the operation table, the flow and `mfa` actions, their response guards and step-up).
 * The budget was raised from 11 kB to 12 kB with that step, which had left twelve bytes of
 * room: enough for fixes, and still far below what a dependency dragging a library in costs,
 * which is what this test exists to catch. OAuth (ADR 0026) added about 1.5 kB (six routes, the
 * tab-scoped binding store, the callback handler and eleven error messages), to 12.5 kB, and
 * the budget moved from 12 kB to 13 kB. Passkeys (ADR 0027) added about 2.3 kB with no
 * dependency (ten routes, the WebAuthn JSON conversions for browsers without
 * `parseCreationOptionsFromJSON` and `toJSON`, the response guards, the autofill loop and
 * eight error messages), to 14.9 kB, and the budget moved from 13 kB to 15.5 kB. Hooks (ADR
 * 0035) added three error codes with their messages (`hook.denied`, `hook.unavailable`,
 * `hook.url_not_allowed`) and no code: 50 bytes, from 15,458 to 15,508, with 42 bytes of room
 * left before them. The budget moved by exactly those 50 bytes, to 15,550, so the room for
 * fixes is what it was; every existing message is unchanged. A phone number on an account
 * (ADR 0037) added 231 bytes, from 15,508 to 15,739: three routes in the operation table,
 * `user.phone` (ask, confirm, remove), the receipt's guard and four error messages
 * (`phone.invalid`, `sms.disabled`, `sms.country_not_allowed`, `sms.unavailable`); no
 * dependency, and the phone number rules of the contract are not in the bundle (the server
 * judges a number). The budget moved by exactly those 231 bytes, to 15,781. The password
 * history (ADR 0038) added one error code with its message (`password.reused`) and no code:
 * 21 bytes, from 15,739 to 15,760. The budget moved by exactly those 21 bytes, to 15,802, so
 * the 42 bytes of room are what they were. Signing in with a texted code (TULA-27) added
 * one error code with its message (`mfa.enrolment_needs_other_sign_in`) and no code: the
 * strategy is two more members of two parameter types. 23 bytes, from 15,760 to 15,783; the
 * budget moved by exactly those 23 bytes, to 15,825. Password expiry (ADR 0041) added one
 * route to the operation table and the sign-in's `submitNewPassword`, and no error code
 * (`password.reused` and `flow.invalid_step` were there): 26 bytes, from 15,783 to 15,809.
 * The budget moved by exactly those 26 bytes, to 15,851. A texted code as the second factor
 * (ADR 0025, TULA-46) added six routes to the operation table, `prepareSecondFactor` on the
 * two flows that can stop at a second factor, `mfa.startSms`, `confirmSms` and `disableSms`,
 * the texted step-up code, and three error codes with their messages
 * (`mfa.needs_other_sign_in`, `mfa.sms_not_allowed`, `mfa.phone_number_required`): 290 bytes,
 * from 15,809 to 16,099. The budget moved by exactly those 290 bytes, to 16,141.
 * Device binding (ADR 0043) added 586 bytes with no dependency, measured on the tree that
 * has both: from 16,099 to 16,685. They are the three error codes and their messages
 * (`device.proof_invalid`, `device.nonce_required`, `device.binding_not_supported`), making
 * a proof (the contract's `createDpopProof` and its base64url, web platform APIs only), the
 * transport's proof on the five starts and the refresh, the one repeat after a nonce
 * challenge, the client's own `device.key_failed` and the refusal of a key for a `web`
 * client. `generateSoftwareDeviceKey` is exported and is not in this number: an application
 * that brings its own key does not pay for it. The budget was set from that measurement,
 * not by adding two branches' raises: 16,685 and the same 42 bytes of room, 16,727.
 * The device-binding option of a session profile (ADR 0043, TULA-34) added one error code
 * with its message (`device.binding_required`) and no code: 14 bytes, from 16,685 to 16,699.
 * **The budget did not move**: the 14 bytes came out of the room, which is 28 bytes now and
 * no longer 42. The next addition measures again and decides whether to restore it.
 * The native ID-token sign-in (ADR 0045) added 110 bytes with no dependency and no error
 * code, measured on the tree that has both: two routes in the operation table,
 * `signIn.withIdToken` with its check of the start's answer, and the start as the sixth
 * among the requests a device key proves: from 16,699 to 16,809. The budget moved by
 * exactly those 110 bytes, to 16,837: the room is the 28 bytes it was and was not restored
 * to 42, which would have raised the budget further than the addition.
 * Native Apple sign-in (ADR 0047) added 5 bytes: the optional name `exchange` passes on
 * beside the ID token (Apple's token carries none), from 16,809 to 16,814. The client does
 * not hash the nonce for Apple (an app does, with its platform's API), so nothing else was
 * added. **The budget did not move**: the room is 23 bytes now.
 * The passkey provider (ADR 0048: a runtime that is not a browser asks its platform for a
 * passkey through `Environment.passkeyProvider`) added 19 bytes with no dependency and no
 * error code, measured on the tree that has both, from 16,814 to 16,833 (16,809 to 16,828
 * before native Apple sign-in was merged): the first version of it cost 78, and what brought it
 * down is that a browser's `navigator.credentials` became one such provider
 * (`browserProvider`), so both go through the same checks, and that "this runtime has no
 * passkeys" is said in one place instead of three. **The budget did not move**: the room is
 * 4 bytes now. `createTulaClientWithEnvironment` and `runtimeEnvironment` are exported and
 * cost an application that calls `createTulaClient` nothing. Mind that the number moves by a
 * few bytes with the names the minifier happens to choose (the same sources measured 16,830
 * and 16,837 around an unrelated export): the next addition has no room to count on and
 * measures first.
 * A device key the runtime finds when it is asked (ADR 0052: `Environment.deviceKey`, for a
 * key in a phone's secure hardware, which a native call finds or makes and which is not
 * there when the client is created) added 42 bytes with no dependency and no error code,
 * from 16,833 to 16,875: the transport asks a source for its key before each request a key
 * proves and sends the request without a proof when the answer is no key, a key handed over
 * as an option became such a source, and a key may name a proof's id itself (`proofId`,
 * for an engine without `crypto.getRandomValues`). The budget moved by exactly those 42
 * bytes, to 16,879: the room is the 4 bytes it was.
 * Holding that lookup, and the signing after it, to the call's deadline added 40 bytes,
 * from 16,875 to 16,915: a key store is a native call that can be left unsettled, and a
 * refresh that waited for one for ever would hold the single flight for ever (found in
 * review, after the 42 above were counted). Three shapes were measured (a race of two
 * promises, 44; one promise the abort rejects, with the work as an async function, 40, or
 * as a `then` chain, 41) and the cheapest kept. The budget moved by exactly those 40 bytes,
 * to 16,919: the room is the 4 bytes it was.
 * An email address for an account that has none (ADR 0059: `user.email.request` and
 * `user.email.verify`, for an account made through X or Facebook) added 57 bytes with no
 * dependency, from 16,915 to 16,972. Measured apart: 27 for the two rows the generated
 * operation table gains (every new `/v1/client/` route costs its row here, whether or not
 * the client calls it), 7 for the message of the one new contract code
 * (`email.already_set`), 23 for the two calls. Three shapes of the calls were measured (a
 * helper shared with `user.phone.request`, 30; that helper with the "still the session
 * that asked" comparison of `asUser` and the factor confirmations folded into one, 31:
 * what gzip already sees twice costs nothing to say twice; the phone call's own lines
 * repeated, 23) and the cheapest kept. No saving elsewhere was found that is not a worse
 * message or a renamed public operation. The budget moved by exactly those 57 bytes, to
 * 16,976: the room is the 4 bytes it was. The five codes of organizations (ADR 0065:
 * `organization.disabled`, `.slug_taken`, `.member_exists`, `.last_manager`, `.role_unknown`)
 * added 135 bytes, from 16,972 to 17,107, all of it their messages: the client calls no
 * organization route yet. The budget moved by exactly those 135 bytes, to 17,111: the room
 * is the 4 bytes it was.
 * The four contract codes of a user import (ADR 0066: `import.unsupported_algorithm`,
 * `import.hash_malformed`, `import.hash_parameters_too_weak`,
 * `import.hash_parameters_too_costly`) added 88 bytes, from 17,107 to 17,195: the code
 * names and their messages, which every client carries because the table of messages is
 * the contract's. A fifth code, for metadata over its size, cost 19 more and was dropped for
 * `validation.failed`, and the messages were cut to one short line each (the first wording
 * cost 179 bytes for five codes, 107 after shortening them). The budget moved by exactly
 * those 88 bytes, from 17,111 to 17,199: the room is the 4 bytes it was.
 * The four contract codes of custom organization roles (ADR 0065: `organization.role_exists`,
 * `organization.role_in_use`, `organization.role_built_in`, `organization.role_limit`) added
 * 107 bytes, from 17,195 to 17,302, the names and messages again. The budget moved by exactly
 * those 107 bytes, from 17,199 to 17,306: the room is the 4 bytes it was.
 * The client side of organizations (ADR 0065, Orgs 02) added 462 bytes, from 17,302 to 17,764
 * (measured on top of the custom role codes above): the four contract codes of the user's own
 * organization routes and their messages, the three operation rows,
 * `organizations.{list,create,setActive}`, the `org_id` read of the access token for
 * `state.organizationId`, and `setActiveOrganization` with its stale-generation handling
 * (shaped like `stepUp`, which it shares `send` and `commit` with). The budget moved by
 * exactly those 462 bytes, from 17,306 to 17,768: the room is the 4 bytes it was.
 * Invitations by email (ADR 0065, Orgs 04) added 393 bytes, from 17,764 to 18,157: the ten
 * contract codes with their messages (cut to one short sentence each; the first wording cost
 * 452 bytes for everything), six operation rows and `organizations.invitations`
 * (`list`, `invite`, `revoke`, `preview`, `accept`, `decline`). `readInvitationLink` is not in
 * the bundle of a client that does not import it. The budget moved by exactly those 393
 * bytes, from 17,768 to 18,161: the room is the 4 bytes it was.
 */
const GZIP_BUDGET_BYTES = 18_161

async function bundle(source: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'testing', source)],
    target: 'browser',
    minify: true,
  })
  expect(built.success).toBe(true)
  return (await built.outputs[0]?.text()) ?? ''
}

describe('what @tula-tech/core costs a browser bundle', () => {
  test('the client stays within its size budget', async () => {
    const code = await bundle('bundle-entry.ts')
    expect(code).toContain('x-tula-publishable-key')
    expect(Bun.gzipSync(Buffer.from(code)).byteLength).toBeLessThan(GZIP_BUDGET_BYTES)
  })

  test('nothing brings Zod (or any schema library) along', async () => {
    const code = await bundle('bundle-entry.ts')
    for (const marker of ['ZodType', '_zod', 'safeParse', 'toJSONSchema']) {
      expect(code).not.toContain(marker)
    }
  })

  test('uses no Node or Bun API', async () => {
    const code = await bundle('bundle-entry.ts')
    for (const marker of ['node:', 'process.env', 'require(', 'Bun.']) {
      expect(code).not.toContain(marker)
    }
    // Node's `Buffer`, not the web platform's `ArrayBuffer` (which the passkey conversions use).
    expect(code).not.toMatch(/(?<![A-Za-z_$])Buffer\b/)
  })
})
