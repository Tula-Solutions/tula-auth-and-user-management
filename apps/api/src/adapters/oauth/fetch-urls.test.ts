import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// H-212: three adapters call `fetch` directly instead of through `Outbound.request`, which is
// safe only while no URL they fetch comes from an operator. This pins what each is handed: a
// constant, a template that starts with one, or an address built from PUBLIC_URL.
const SRC = join(import.meta.dir, '../..')

async function read(path: string): Promise<string> {
  return Bun.file(join(SRC, path)).text()
}

/** The first argument of every call to `name(` in a source text. */
function firstArguments(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`[^\\w.]${name}\\(\\s*([^,)]+(?:\\([^)]*\\))?)`, 'g'))].map(
    (match) => (match[1] ?? '').trim()
  )
}

const CONSTANT = /^(`\$\{)?[A-Z][A-Z0-9_]+\b/

describe('adapters that call fetch directly are never handed an operator-typed address', () => {
  test('every readProfile call (profile-read.ts) starts from a constant URL', async () => {
    const files = ['discord', 'facebook', 'github', 'linkedin', 'x']
    let calls = 0
    for (const file of files) {
      const args = firstArguments(await read(`adapters/oauth/${file}.ts`), 'readProfile').filter(
        (arg) => !arg.startsWith('url:')
      )
      for (const arg of args) {
        calls += 1
        // facebook builds `url` from FACEBOOK_USER_URL; checked below.
        expect(arg.startsWith('url.toString') || CONSTANT.test(arg)).toBe(true)
      }
    }
    expect(calls).toBeGreaterThanOrEqual(5)
    expect(await read('adapters/oauth/facebook.ts')).toContain('new URL(FACEBOOK_USER_URL)')
  })

  test('every remoteKeySet call (id-token.ts) is a constant, or a rule table written in code', async () => {
    const providers = ['linkedin', 'microsoft', 'id-token']
    for (const file of providers) {
      for (const arg of firstArguments(
        await read(`adapters/oauth/${file}.ts`),
        'remoteKeySet'
      ).filter((arg) => !arg.includes(':'))) {
        expect(arg === 'rules.jwksUrl' || CONSTANT.test(arg)).toBe(true)
      }
    }
    for (const file of ['apple', 'google']) {
      expect(await read(`adapters/oauth/${file}.ts`)).toMatch(/jwksUrl: 'https:\/\/[a-z.]+\//)
    }
  })

  test('the diagnostics probes (diagnostics.ts) fetch PUBLIC_URL-derived addresses only', async () => {
    const service = await read('modules/instance/service.ts')
    expect(service).toMatch(/const statusUrl = `\$\{publicBase\(config\)\}\/v1\/status`/)
    expect(service).toMatch(/probes\.httpStatus\(statusUrl,/)
    const native = await read('modules/instance/native.ts')
    expect(native).toMatch(/const url = `\$\{base\}\/v1\/environments\//)
    expect(native).toMatch(/httpDocument\(url,/)
  })
})
