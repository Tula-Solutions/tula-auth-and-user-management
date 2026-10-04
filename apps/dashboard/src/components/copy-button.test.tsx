import { afterEach, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from './copy-button'

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function clipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

afterEach(() => {
  if (original) {
    Object.defineProperty(navigator, 'clipboard', original)
  }
})

test('copies the value to the clipboard and says so', async () => {
  const written: string[] = []
  clipboard(async (value) => {
    written.push(value)
  })
  render(<CopyButton value='tula_pk_dev_example' label='Copy key' />)
  // After `userEvent.setup()`, which installs its own clipboard stub.
  const user = userEvent.setup()
  clipboard(async (value) => {
    written.push(value)
  })
  await user.click(screen.getByRole('button', { name: 'Copy key' }))
  expect((await screen.findByText('Copied')).getAttribute('role')).toBe('status')
  expect(written).toEqual(['tula_pk_dev_example'])
})

test('a clipboard that refuses is said, not swallowed', async () => {
  render(<CopyButton value='x' label='Copy key' />)
  const user = userEvent.setup()
  clipboard(() => Promise.reject(new Error('denied')))
  await user.click(screen.getByRole('button', { name: 'Copy key' }))
  expect(await screen.findByText('Copy it by hand')).toBeDefined()
})
