import { expect, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import { expectFocus } from '~/testing/harness'
import { Modal } from './modal'

function dialog(): HTMLDialogElement {
  return screen.getByRole('dialog') as HTMLDialogElement
}

/** Escape on a modal dialog is a `cancel` event the page may refuse. */
function escapeRefused(): boolean {
  const asked = new Event('cancel', { cancelable: true })
  act(() => {
    dialog().dispatchEvent(asked)
  })
  return asked.defaultPrevented
}

test('a dialog that is not busy lets Escape through and reports the close', () => {
  let closed = 0
  render(<Modal open onClose={() => closed++} title='Add a thing' />)
  expect(escapeRefused()).toBe(false)
  act(() => dialog().close())
  expect(closed).toBe(1)
})

test('a busy dialog refuses Escape, and undoes a close the browser forces', () => {
  let closed = 0
  render(<Modal open busy onClose={() => closed++} title='Add a thing' />)
  expect(escapeRefused()).toBe(true)
  act(() => dialog().close())
  expect(dialog().open).toBe(true)
  expect(closed).toBe(0)
})

test('a dialog that stops being busy can be closed again', () => {
  let closed = 0
  const view = render(<Modal open busy onClose={() => closed++} title='Add a thing' />)
  view.rerender(<Modal open onClose={() => closed++} title='Add a thing' />)
  expect(escapeRefused()).toBe(false)
  act(() => dialog().close())
  expect(closed).toBe(1)
})

test('a dialog that becomes another one while open moves the focus to its new title', async () => {
  const view = render(<Modal open onClose={() => {}} title='Add a thing' />)
  view.rerender(<Modal open onClose={() => {}} title='Copy it now' />)
  await expectFocus(screen.getByRole('heading', { name: 'Copy it now' }))
})

test('opening a dialog does not move the focus to its title', () => {
  render(<Modal open onClose={() => {}} title='Add a thing' />)
  expect(document.activeElement === screen.getByRole('heading', { name: 'Add a thing' })).toBe(
    false
  )
})
