import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { messageFor } from '~/api/errors'
import { ActionButton } from './action-button'
import { Modal } from './modal'
import { Input } from './ui/input'
import { Label } from './ui/label'

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  open: boolean
  /** The question, naming what is acted on ("Ban ada@example.com?"). */
  title: ReactNode
  /** What will happen, in a sentence or two. */
  children?: ReactNode
  /** The confirming button's label ("Ban user"). */
  confirmLabel: string
  /** Style the confirming button as destructive. */
  destructive?: boolean
  /**
   * Text the operator must type before the action is allowed (a user's email in a production
   * environment). Compared exactly.
   */
  requireText?: string
  /**
   * True while the action runs. The dialog also keeps its button unavailable by itself, from
   * the confirmation until it closes or `error` says the action was refused.
   */
  pending?: boolean
  /**
   * The action's failure, shown in the dialog. It is also what gives the confirming button
   * back: a screen that keeps the dialog open after a refusal passes it.
   */
  error?: unknown
  /**
   * The sentence for the failure, for a screen whose refusals have words of their own.
   * Defaults to {@link messageFor}.
   */
  errorText?: (error: unknown) => string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A confirmation in front of an action that cannot be taken back.
 *
 * Cancel comes first in the document, so it is what Enter and the initial focus land on
 * unless the operator has to type the confirmation text.
 *
 * A confirmed change is sent once: the confirming button is unavailable from the click until
 * the dialog closes, whatever `pending` says. A screen's request has succeeded, and is no
 * longer pending, while the screen reads its lists again before it closes the dialog; a
 * button that followed `pending` alone would send the request a second time in that moment.
 * A refusal (`error`) gives the button back.
 *
 * @param props - See {@link ConfirmDialogProps}.
 * @returns The dialog.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  requireText,
  pending = false,
  error,
  errorText = messageFor,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  // Confirmed in this opening of the dialog. Not the action's own pending state: that ends
  // with the request, and the dialog is still open while the lists are read again.
  const [confirmed, setConfirmed] = useState(false)
  const allowed = requireText === undefined || typed === requireText
  const running = pending || (confirmed && !error)

  useEffect(() => {
    if (!open) {
      setTyped('')
      setConfirmed(false)
    }
  }, [open])

  function submit(event: FormEvent) {
    event.preventDefault()
    // Enter in the typed confirmation submits the form without a click on the button.
    if (allowed && !running) {
      setConfirmed(true)
      onConfirm()
    }
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} description={children}>
      <form onSubmit={submit} className='flex flex-col gap-4'>
        {requireText !== undefined ? (
          <div className='flex flex-col gap-2'>
            <Label htmlFor={inputId}>
              {/* Kept apart from the sentence's direction: what is typed is a name, an
                  address, text from the server, in whatever script it is in. */}
              Type <bdi className='font-mono font-semibold break-all'>{requireText}</bdi> to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete='off'
              spellCheck={false}
            />
          </div>
        ) : null}
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {errorText(error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton
            type='submit'
            variant={destructive ? 'destructive' : 'default'}
            pending={running}
            aria-disabled={!allowed || running || undefined}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
