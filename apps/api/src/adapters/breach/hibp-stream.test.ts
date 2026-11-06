import { describe, expect, test } from 'bun:test'
import { HIBP_MAX_RESPONSE_BYTES, HibpBreachChecker } from '~/adapters/breach/hibp'

// SHA-1('password') = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8'

/** A chunked body with no Content-Length, `total` bytes long, that counts what was pulled. */
function chunked(total: number, tail = '') {
  const state = { pulled: 0 }
  const chunk = new Uint8Array(64 * 1024).fill(0x41)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) {
        controller.enqueue(new TextEncoder().encode(tail))
        controller.close()
        return
      }
      state.pulled += chunk.length
      controller.enqueue(chunk)
    },
  })
  return { response: new Response(stream), state }
}

describe('HibpBreachChecker body cap (H-208)', () => {
  test('a chunked body past the cap is unknown and the stream stops being read', async () => {
    const { response, state } = chunked(HIBP_MAX_RESPONSE_BYTES * 8)
    const fetch = (async () => response) as unknown as typeof globalThis.fetch
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('unknown')
    expect(state.pulled).toBeLessThan(HIBP_MAX_RESPONSE_BYTES * 2)
  })

  test('a small chunked body is still read', async () => {
    const fetch = (async () =>
      new Response(`${SUFFIX}:5\r\n`)) as unknown as typeof globalThis.fetch
    expect(await new HibpBreachChecker({ fetch }).check('password')).toBe('breached')
  })
})
