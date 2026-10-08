import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { Glob } from 'bun'
import { useEffect, useState } from 'react'
import { expectAbsent, world } from './harness'

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

/** Keep the thread busy for a while, as a runner that has been given no CPU does. */
function stall(milliseconds: number) {
  const until = performance.now() + milliseconds
  while (performance.now() < until) {
    // Busy on purpose: time has to pass without the event loop turning.
  }
}

/**
 * Run `run` as a starved CI runner would: every zero-delay timer is already due by the time the
 * event loop looks again. That is the one thing about a slow machine the race below needs, and
 * with it the two tests that failed on CI (TULA-64) fail every time instead of once in a while.
 */
async function onAStarvedRunner(run: () => Promise<void>): Promise<void> {
  const real = globalThis.setTimeout
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof real>) => {
    const timer = real(...args)
    if ((args[1] ?? 0) === 0) {
      stall(3)
    }
    return timer
  }, real)
  try {
    await run()
  } finally {
    globalThis.setTimeout = real
  }
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

describe('what a test sees after it has waited (`reactSettled`, installed by setup.ts)', () => {
  /** What the step below has done so far. */
  interface Seen {
    effects: number
    /** An effect that takes the focus, as a screen's title does. */
    focused: boolean
  }

  /**
   * A screen as the components draw one: an effect after the commit (it takes the focus and
   * asks the "browser" something), and a second render with the answer.
   */
  function Step(props: { seen: Seen }) {
    const { seen } = props
    const [answer, setAnswer] = useState<string | null>(null)
    useEffect(() => {
      seen.effects += 1
      seen.focused = true
      setAnswer('answered')
    }, [seen])
    return (
      <>
        <p>step</p>
        <p data-testid='answer'>{answer ?? 'not asked yet'}</p>
      </>
    )
  }

  /** Shows the step when told to from outside React, as when an API answer arrives. */
  function Page(props: { seen: Seen; control: { show(): void } }) {
    const [shown, setShown] = useState(false)
    props.control.show = () => setShown(true)
    return (
      <>
        <button type='button' onClick={() => void Promise.resolve().then(() => setShown(true))}>
          Continue
        </button>
        {shown ? <Step seen={props.seen} /> : null}
      </>
    )
  }

  // TULA-64. `findBy…` used to return as soon as the element was in the document: after the
  // commit, but on a slow runner before the commit's effects (the scheduler runs them in a
  // later turn of the event loop, and Testing Library's zero-delay timer got there first).
  // One test then saw a link an effect was about to take away; another started typing, and
  // the title's focus effect ran under the first key and took the other five.
  test('`findBy…` returns after the effects of the commit that drew the element, and after the render they asked for', async () => {
    const seen: Seen = { effects: 0, focused: false }
    const control = { show: () => undefined }
    render(<Page seen={seen} control={control} />)

    await onAStarvedRunner(async () => {
      // Outside `act`, while the query waits: how every answer of the fake API arrives.
      queueMicrotask(() => control.show())
      await screen.findByText('step')
    })

    expect(seen).toEqual({ effects: 1, focused: true })
    expect(screen.getByTestId('answer').textContent).toBe('answered')
  })

  test('a user-event call returns after what it set off has been drawn and its effects have run', async () => {
    const seen: Seen = { effects: 0, focused: false }
    const w = world()
    w.mount(<Page seen={seen} control={{ show: () => undefined }} />)

    await onAStarvedRunner(() => w.user.click(screen.getByRole('button', { name: 'Continue' })))

    expect(seen).toEqual({ effects: 1, focused: true })
    expect(screen.getByTestId('answer').textContent).toBe('answered')
  })
})

describe('expectAbsent', () => {
  test('passes for nothing, and fails with a line about the element, never the element', () => {
    render(<button type='button'>Sign in with a passkey</button>)
    expectAbsent(screen.queryByRole('link'))

    let message = ''
    try {
      expectAbsent(screen.queryByRole('button'))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('<button> Sign in with a passkey')
    // The matcher it replaces wrote 290 MB for this.
    expect(message.length).toBeLessThan(2_000)
  })

  test('no test of this package hands a query’s result to `toBeNull`', async () => {
    // `expect(<a query that may find an element>).toBeNull()`, on one line or as the formatter
    // breaks it. It fails only when it has an element, and then formats the whole window.
    const pattern =
      /expect\((?:(?!expect\()[\s\S]){0,400}?(?:queryBy|querySelector\()(?:(?!expect\()[\s\S]){0,400}?\)\s*\.toBeNull\(\)/
    const offenders: string[] = []
    const root = `${import.meta.dir}/..`
    for await (const path of new Glob('**/*.test.tsx').scan(root)) {
      if (pattern.test(await Bun.file(`${root}/${path}`).text())) {
        offenders.push(path)
      }
    }
    expect(offenders).toEqual([])
  })
})
