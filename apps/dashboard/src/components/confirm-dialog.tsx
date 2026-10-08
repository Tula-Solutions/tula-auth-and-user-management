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
  title: string
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
  /** True while the action runs. */
  pending?: boolean
  /** The action's failure, shown in the dialog. */
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
  const allowed = requireText === undefined || typed === requireText

  useEffect(() => {
    if (!open) {
      setTyped('')
    }
  }, [open])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (allowed) {
      onConfirm()
    }
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} description={children}>
      <form onSubmit={submit} className='flex flex-col gap-4'>
        {requireText !== undefined ? (
          <div className='flex flex-col gap-2'>
            <Label htmlFor={inputId}>
              Type <span className='font-mono font-semibold break-all'>{requireText}</span> to
              confirm
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
            pending={pending}
            aria-disabled={!allowed || pending || undefined}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
