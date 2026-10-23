import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createTulaClient } from '@tula-tech/core'
import { TulaProvider } from '@tula-tech/react'
import { expectFocus } from '../../react/src/testing/harness'
import { FormAlert, Status } from './status'
import { StepCard } from './step-card'

// No network: a client whose every call is answered "signed out", so the provider's refresh
// has somewhere to go.
const client = createTulaClient({
  publishableKey: 'tula_pk_dev_unit00000000000000000000000000',
  baseUrl: 'https://auth.test',
  fetch: async () =>
    new Response(JSON.stringify({ status: 401, code: 'auth.unauthenticated', detail: 'no' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
})

const wrap = (node: React.ReactNode) => render(<TulaProvider client={client}>{node}</TulaProvider>)

describe('StepCard', () => {
  test('is a group named by its title, with description, content and footer', () => {
    wrap(
      <StepCard title='Hello' description='Pick one' footer={<a href='/x'>Other way</a>}>
        <p>body</p>
      </StepCard>
    )
    expect(screen.getByRole('group', { name: 'Hello' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeTruthy()
    expect(screen.getByText('Pick one')).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Other way' })).toBeTruthy()
  })

  test('the title takes the focus when focusTitle is set, and not otherwise', async () => {
    const first = wrap(<StepCard title='Focused' focusTitle />)
    await expectFocus(screen.getByRole('heading', { name: 'Focused' }))
    first.unmount()
    wrap(<StepCard title='Quiet' />)
    expect(document.activeElement).toBe(document.body)
  })

  test('the heading level is a prop', () => {
    wrap(<StepCard title='Nested' level={3} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Nested' })).toBeTruthy()
  })
})

describe('Status and FormAlert', () => {
  test('Status is a polite live region, empty for null', () => {
    const { container } = render(<Status message={null} />)
    expect(container.querySelector('output')?.textContent).toBe('')
    render(<Status message='Saved' />)
    expect(screen.getByText('Saved').closest('output')).toBeTruthy()
  })

  test('the neutral tone draws no success icon', () => {
    const { container } = render(<Status message='Dismissed' tone='neutral' />)
    expect(container.querySelector('svg')).toBeNull()
  })

  test('FormAlert is an alert with its detail, and nothing for no message', () => {
    const { container } = render(<FormAlert message={null} />)
    expect(container.firstChild).toBeNull()
    render(<FormAlert message='Nope' detail='Try again in 5s.' />)
    expect(screen.getByRole('alert').textContent).toContain('Nope')
    expect(screen.getByText('Try again in 5s.')).toBeTruthy()
  })
})
