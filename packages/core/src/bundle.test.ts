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
 * the 42 bytes of room are what they were.
 */
const GZIP_BUDGET_BYTES = 15_802

async function bundle(source: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'testing', source)],
    target: 'browser',
    minify: true,
  })
  expect(built.success).toBe(true)
  return (await built.outputs[0]?.text()) ?? ''
}

describe('what @tula/core costs a browser bundle', () => {
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
