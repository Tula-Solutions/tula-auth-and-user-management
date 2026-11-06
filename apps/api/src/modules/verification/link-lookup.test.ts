import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'
import { AuthError } from '~/exceptions'
import * as Verification from '~/modules/verification/service'
import { createTestDeps, TEST_TENANT } from '~/testing'

// H-248: `findByLinkHash` returns a token whatever its state (used, expired, any purpose). That is
// safe only while `verifyLink` is the one caller and makes those checks itself.
describe('findByLinkHash has one caller (H-248)', () => {
  test('only verifyLink calls it outside tests', () => {
    const srcRoot = `${import.meta.dir}/../..`
    const callers = [...new Glob('**/*.ts').scanSync(srcRoot)].filter((file) => {
      return (
        !/\.(test|suite|integration)\.ts$/.test(file) &&
        readFileSync(`${srcRoot}/${file}`, 'utf8').includes('.findByLinkHash(')
      )
    })
    expect(callers).toEqual(['modules/verification/service.ts'])
  })

  test('verifyLink refuses a link past its expiry', async () => {
    const deps = createTestDeps()
    const tenant = { ...TEST_TENANT }
    await Verification.issue(deps, tenant, {
      purpose: 'email_verification',
      destination: 'maya@northline.app',
      flowAttemptId: '00000000-0000-7000-8000-00000000f001',
      linkUrl: (token) => `https://auth.test/verify/${token}`,
    })
    const linkToken = /verify\/([\w-]+)/.exec(deps.mailer.last().text)?.[1] ?? ''
    deps.clock.advance(10 * 60_000)
    const error = await Verification.verifyLink(deps, tenant, {
      purpose: 'email_verification',
      linkToken,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).code).toBe('verification.expired')
  })
})
