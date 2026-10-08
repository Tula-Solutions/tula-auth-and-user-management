import { type ReactNode, useEffect, useId, useRef } from 'react'
import { cn } from '~/lib/utils'

/** Props of {@link Modal}. */
export interface ModalProps {
  /** Whether the dialog is shown. */
  open: boolean
  /** Called when the operator dismisses it (Escape, or a button that calls it). */
  onClose: () => void
  /** The dialog's heading; it names the dialog for assistive technology. */
  title: string
  /** A sentence under the heading that describes the dialog. */
  description?: ReactNode
  /** The body; rendered only while the dialog is open. */
  children?: ReactNode
  /** Buttons, right-aligned under the body. */
  footer?: ReactNode
  /** Extra classes for the panel. */
  className?: string
  /**
   * The dialog cannot be dismissed now: Escape is refused, and a close the browser forces
   * anyway is undone. For a request whose answer the dialog must be there to show (a secret
   * that is returned once): the server has acted by the time it answers.
   */
  busy?: boolean
}

/**
 * A modal dialog on the platform's own `<dialog>`.
 *
 * `showModal()` gives what a dialog needs without any library: the rest of the page is inert
 * (nothing behind the dialog can be focused or clicked), focus stays inside, Escape closes it
 * and focus returns to the control that opened it. It does not lock scrolling: the page
 * behind can still be scrolled, which the libraries that prevent it do by injecting a style
 * element. No
 * script-injected stylesheet is involved, which the dashboard's Content-Security-Policy would
 * refuse. The body is rendered only while open, so whatever it showed (a new API key) is gone
 * from the document once it closes.
 *
 * @param props - See {@link ModalProps}.
 * @returns The dialog element (present but closed when `open` is false).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  busy = false,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const shownTitle = useRef<string | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) {
      return
    }
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // A dialog that becomes another one while it is open (a form, then its result) took away
  // what had the focus and said nothing: the focus goes to the new title, which is read.
  useEffect(() => {
    if (open && shownTitle.current !== null && shownTitle.current !== title) {
      heading.current?.focus()
    }
    shownTitle.current = open ? title : null
  }, [open, title])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Escape. The backdrop needs nothing: a click on it does not close a `<dialog>`.
      onCancel={(event) => {
        if (busy) {
          event.preventDefault()
        }
      }}
      onClose={() => {
        if (open && busy) {
          // A browser closes on a second Escape whatever the first was answered with.
          ref.current?.showModal()
          return
        }
        if (open) {
          onClose()
        }
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border bg-card p-0 text-card-foreground shadow-lg',
        className
      )}
    >
      {open ? (
        <div className='flex flex-col gap-4 p-6'>
          <div className='flex flex-col gap-1.5'>
            <h2
              ref={heading}
              id={titleId}
              tabIndex={-1}
              className='text-lg font-semibold break-words outline-none'
            >
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className='text-sm text-muted-foreground'>
                {description}
              </div>
            ) : null}
          </div>
          {children}
          {footer ? <div className='flex flex-wrap justify-end gap-2'>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}
