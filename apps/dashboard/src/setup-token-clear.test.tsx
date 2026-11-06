import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { boot, resetSetup, setupRequest } from '~/features/setup/setup-api'

afterEach(() => {
  resetSetup()
})

describe('setup token after a refusal (TULA-171, H-054)', () => {
  test('a link the server calls invalid is forgotten: the next call sends nothing', async () => {
    window.history.replaceState(null, '', '/dashboard/setup#token=tula_setup_dead')
    boot()
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ status: 401, code: 'auth.invalid_key', detail: 'no' }), {
          status: 401,
        })) as unknown as typeof fetch
    )
    await expect(setupRequest('')).rejects.toMatchObject({ code: 'auth.invalid_key' })
    await expect(setupRequest('')).rejects.toMatchObject({ code: 'auth.invalid_key' })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
