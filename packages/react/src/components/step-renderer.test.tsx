import { describe, expect, mock, test } from 'bun:test'
import { act, screen } from '@testing-library/react'
import type { FlowStep } from '@tula-tech/core'
import { useEffect, useState } from 'react'
import { expectAbsent, world } from '../testing/harness'
import { StepRenderer, type StepRendererProps, type StepScreens } from './step-renderer'
import { useScreenChanged } from './ui'

const PASSWORD: FlowStep = { status: 'needs_password' }
const VERIFY: FlowStep = {
  status: 'needs_email_verification',
  destination: 'm***@northline.app',
  strategies: ['email_code'],
} as FlowStep
/** A status no version of this package knows: what a newer server may send. */
const FROM_THE_FUTURE = { status: 'needs_teleport' } as unknown as FlowStep

const NOT_SUPPORTED = 'This step is not supported'

describe('<StepRenderer>', () => {
  test('draws the screen of the step, given the step narrowed to its status', () => {
    const w = world()
    w.mount(
      <StepRenderer
        step={VERIFY}
        screens={{
          needs_password: () => <p>password</p>,
          needs_email_verification: (step) => <p>code sent to {step.destination}</p>,
        }}
        onRestart={() => undefined}
      />
    )
    expect(screen.getByText('code sent to m***@northline.app')).toBeTruthy()
    expectAbsent(screen.queryByText('password'))
  })

  test('draws `start` before the flow has a step', () => {
    const w = world()
    w.mount(
      <StepRenderer
        step={null}
        start={<p>start</p>}
        screens={{ needs_password: () => <p>password</p> }}
        onRestart={() => undefined}
      />
    )
    expect(screen.getByText('start')).toBeTruthy()
  })

  test('no step and no start screen is the "not supported" screen, not a blank card', () => {
    const w = world()
    w.mount(<StepRenderer step={null} screens={{}} onRestart={() => undefined} />)
    expect(screen.getByText(NOT_SUPPORTED)).toBeTruthy()
  })

  test('a status no version knows is the "not supported" screen, and it can start again', async () => {
    const w = world()
    const onRestart = mock()
    w.mount(
      <StepRenderer
        step={FROM_THE_FUTURE}
        screens={{ needs_password: () => <p>password</p> }}
        onRestart={onRestart}
      />
    )
    expect(screen.getByText(NOT_SUPPORTED)).toBeTruthy()
    expect(
      document.querySelector('[data-tula-unsupported]')?.textContent?.includes('not supported')
    ).toBe(true)
    await w.user.click(screen.getByRole('button', { name: 'Start again' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  test('a known status the map leaves out is the "not supported" screen too', () => {
    const w = world()
    w.mount(
      <StepRenderer
        step={PASSWORD}
        screens={{ needs_email_verification: () => <p>code</p> }}
        onRestart={() => undefined}
      />
    )
    expect(screen.getByText(NOT_SUPPORTED)).toBeTruthy()
    expectAbsent(screen.queryByText('code'))
  })

  test('a screen that returns nothing cannot draw its step: the fallback, never a blank card', () => {
    for (const nothing of [null, undefined, false]) {
      const w = world()
      const view = w.mount(
        <StepRenderer
          step={PASSWORD}
          screens={{ needs_password: () => nothing }}
          onRestart={() => undefined}
        />
      )
      expect(screen.getByText(NOT_SUPPORTED)).toBeTruthy()
      view.unmount()
    }
  })

  test('a status named like an inherited property is not a screen of the map', () => {
    const w = world()
    w.mount(
      <StepRenderer
        step={{ status: 'constructor' } as unknown as FlowStep}
        screens={{}}
        onRestart={() => undefined}
      />
    )
    expect(screen.getByText(NOT_SUPPORTED)).toBeTruthy()
  })

  test('a copied component outside a prebuilt root gets the fallback in a root of its own', () => {
    const w = world()
    w.mount(<StepRenderer step={FROM_THE_FUTURE} screens={{}} onRestart={() => undefined} />)
    expect(document.querySelectorAll('[data-tula-element="root"]')).toHaveLength(1)
  })

  test('a new screen name draws the screen afresh; the same name keeps its state', () => {
    const w = world()
    let mounts = 0
    function Counter() {
      useEffect(() => {
        mounts++
      }, [])
      return <p>screen</p>
    }
    let change = (_next: { screen: string; round: number }) => {}
    function Host() {
      const [state, setState] = useState({ screen: 'sign-in:needs_password', round: 0 })
      change = setState
      return (
        <StepRenderer
          step={{ ...PASSWORD }}
          screen={state.screen}
          screens={{ needs_password: () => <Counter /> }}
          onRestart={() => undefined}
        />
      )
    }
    w.mount(<Host />)
    expect(mounts).toBe(1)
    act(() => change({ screen: 'sign-in:needs_password', round: 1 }))
    expect(mounts).toBe(1)
    act(() => change({ screen: 'reset:needs_password', round: 2 }))
    expect(mounts).toBe(2)
  })
})

describe('useScreenChanged', () => {
  test('is false on the first screen and true once the screen has changed', () => {
    const seen: boolean[] = []
    function Probe(props: { screen: string }) {
      seen.push(useScreenChanged(props.screen))
      return null
    }
    const w = world()
    const view = w.mount(<Probe screen='a' />)
    view.rerender(<Probe screen='a' />)
    view.rerender(<Probe screen='b' />)
    expect(seen).toEqual([false, false, true])
  })
})

describe('the types of the step map', () => {
  test('a key that is not a step status does not compile', () => {
    const screens: StepScreens = {
      needs_password: () => null,
      // @ts-expect-error `needs_teleport` is not a step status
      needs_teleport: () => null,
    }
    expect(Object.keys(screens)).toEqual(['needs_password', 'needs_teleport'])
  })

  test('a screen is given its step narrowed to its status', () => {
    const screens: StepScreens = {
      // @ts-expect-error a password step has no `destination`
      needs_password: (step) => step.destination,
      needs_email_verification: (step) => step.destination,
    }
    expect(Object.keys(screens)).toHaveLength(2)
  })

  test('the fallback cannot be replaced, removed or set to nothing', () => {
    const props: StepRendererProps = {
      step: null,
      screens: {},
      onRestart: () => undefined,
      // @ts-expect-error there is no fallback prop: the "not supported" screen is not overridable
      fallback: null,
    }
    expect(props.step).toBeNull()
  })
})
