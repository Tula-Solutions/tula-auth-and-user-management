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
 * which is what this test exists to catch.
 */
const GZIP_BUDGET_BYTES = 12_000

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
    for (const marker of ['node:', 'Buffer', 'process.env', 'require(', 'Bun.']) {
      expect(code).not.toContain(marker)
    }
  })
})
