import type { ComponentProps, MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { Button } from './ui/button'

/** Props of {@link ActionButton}: shadcn's button plus a pending state. */
export interface ActionButtonProps extends ComponentProps<typeof Button> {
  /** True while the action it started is running. */
  pending?: boolean
}

/**
 * A button for anything that can be pending.
 *
 * While pending it stays focusable and says so (`aria-disabled`, `aria-busy`) instead of
 * becoming `disabled`: a disabled button drops keyboard focus to the top of the page.
 *
 * @param props - Button props and `pending`.
 * @returns The button.
 */
export function ActionButton({
  pending = false,
  onClick,
  className,
  variant,
  ...props
}: ActionButtonProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (pending) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }
  return (
    <Button
      type='button'
      variant={variant}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={handleClick}
      className={cn(
        'aria-disabled:cursor-progress aria-disabled:opacity-70',
        // The primitive's dark destructive fill is translucent, which drops white text below
        // 4.5:1; the token colour with the page's own text colour keeps it in both schemes.
        variant === 'destructive' && 'dark:bg-destructive dark:text-background',
        className
      )}
      {...props}
    />
  )
}
