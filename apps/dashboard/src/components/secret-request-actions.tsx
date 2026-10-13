import { useId } from 'react'
import { ActionButton } from './action-button'

/**
 * The two buttons of a form whose answer carries a secret that is shown once.
 *
 * While the request is in flight the form cannot be left: the server acts before it answers,
 * and an answer nobody is there to show is a secret nobody has. Cancel stays focusable, is
 * marked unavailable and says why; the submitting button says what is happening in words.
 * The dialog itself is given `busy` for the same time ({@link Modal}).
 *
 * @param props - `pending`: the request is in flight; `onCancel`; `submitLabel` and
 *   `pendingLabel`: the submitting button's text at rest and while pending; `unavailable`:
 *   the submitting button is marked as not usable yet.
 * @returns Cancel, the submitting button and, while pending, the reason.
 */
export function SecretRequestActions({
  pending,
  onCancel,
  submitLabel,
  pendingLabel,
  onSubmit,
  unavailable = false,
}: {
  pending: boolean
  /**
   * The submitting button cannot be used yet (a confirmation still to be typed). It is
   * marked, not disabled; the form that holds it is what refuses the submit.
   */
  unavailable?: boolean
  onCancel: () => void
  submitLabel: string
  pendingLabel: string
  /** For a button outside a form; a button inside one submits it. */
  onSubmit?: () => void
}) {
  const reasonId = useId()
  return (
    <div className='flex flex-col items-end gap-2'>
      {pending ? (
        <p id={reasonId} role='status' className='text-sm text-muted-foreground'>
          Wait for the server’s answer: it carries the secret, which is shown only this once.
        </p>
      ) : null}
      <div className='flex flex-wrap justify-end gap-2'>
        <ActionButton
          variant='outline'
          aria-disabled={pending || undefined}
          aria-describedby={pending ? reasonId : undefined}
          onClick={() => {
            if (!pending) {
              onCancel()
            }
          }}
        >
          Cancel
        </ActionButton>
        <ActionButton
          type={onSubmit ? 'button' : 'submit'}
          onClick={onSubmit}
          pending={pending}
          aria-disabled={unavailable || pending || undefined}
        >
          {pending ? pendingLabel : submitLabel}
        </ActionButton>
      </div>
    </div>
  )
}
