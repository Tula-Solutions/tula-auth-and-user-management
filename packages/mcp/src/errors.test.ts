import { describe, expect, test } from 'bun:test'
import { toolFailure } from './errors'

/** An error shaped like the admin client's, which `toolFailure` recognises by name. */
const apiError = (code: string, status: number) =>
  Object.assign(new Error('secret detail'), { name: 'TulaAdminError', code, status })

describe('toolFailure sentences', () => {
  test.each([
    ['resource.conflict', 409, 'The API refused the request as it stands now.'],
    ['response.invalid', 0, 'The answer was not the Tula API’s.'],
    ['client.invalid_key', 0, 'The request could not be made.'],
    ['network.failed', 0, 'The API could not be reached.'],
  ])('%s', (code, status, message) => {
    const failure = toolFailure(apiError(code, status))
    expect(failure).toMatchObject({ code, message })
    expect(JSON.stringify(failure)).not.toContain('secret detail')
  })
})
