import { expect, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

test('Escape on a dialog that is not busy asks its owner to close it, and closes nothing itself', () => {
  let closed = 0
  render(<Modal open onClose={() => closed++} title='Add a thing' />)
  // The browser is not left to close it: the owner takes the body away first.
  expect(escapeRefused()).toBe(true)
  expect(closed).toBe(1)
  expect(dialog().open).toBe(true)
})

test('a dialog closes, with its body gone, when its owner says so after Escape', () => {
  function Owner() {
    const [open, setOpen] = useState(true)
    return (
      <Modal open={open} onClose={() => setOpen(false)} title='Add a thing'>
        <p>shown once</p>
      </Modal>
    )
  }
  render(<Owner />)
  escapeRefused()
  expect(screen.queryByText('shown once') === null).toBe(true)
  expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(false)
})

test('a close the browser makes by itself is reported', () => {
  let closed = 0
  render(<Modal open onClose={() => closed++} title='Add a thing' />)
  act(() => dialog().close())
  expect(closed).toBe(1)
})

test('a busy dialog refuses Escape, and undoes a close the browser forces', () => {
  let closed = 0
  render(<Modal open busy onClose={() => closed++} title='Add a thing' />)
  expect(escapeRefused()).toBe(true)
  expect(closed).toBe(0)
  act(() => dialog().close())
  expect(dialog().open).toBe(true)
  expect(closed).toBe(0)
})

test('a dialog that stops being busy can be closed again', () => {
  let closed = 0
  const view = render(<Modal open busy onClose={() => closed++} title='Add a thing' />)
  view.rerender(<Modal open onClose={() => closed++} title='Add a thing' />)
  escapeRefused()
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
