import { describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import { world } from './harness'

/**
 * Count the timers started while `run` is going.
 *
 * A plain wrapper and not `spyOn`: Testing Library takes a mocked `setTimeout` for fake timers
 * and then asks them to advance.
 */
async function timersStartedBy(run: () => Promise<void>): Promise<number> {
  const real = globalThis.setTimeout
  let started = 0
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof real>) => {
    started += 1
    return real(...args)
  }, real)
  try {
    await run()
  } finally {
    globalThis.setTimeout = real
  }
  return started
}

describe('the world’s user', () => {
  // A timer per key is what timed tests out on a contended CI runner: user-event's default
  // waits for one after every keystroke, and each wait is a turn of the event loop that a busy
  // machine stretches from a millisecond to tens of them. A sign-in types some fifty keys.
  test('types without waiting on a timer between keys', async () => {
    const text = 'sturdy-Otter-plays-42-chess'
    const w = world()
    w.mount(<input aria-label='Field' />)
    const field = screen.getByLabelText('Field') as HTMLInputElement

    const timers = await timersStartedBy(() => w.user.type(field, text))

    expect(field.value).toBe(text)
    // Testing Library itself waits once after the whole call; nothing may wait once a key,
    // or once every few keys.
    expect(timers).toBeLessThanOrEqual(2)
  })
})
