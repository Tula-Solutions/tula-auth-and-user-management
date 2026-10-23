import type { ComponentProps } from 'react'

/**
 * The test double of shadcn's `button` primitive: a `<button>` that takes `variant` and `size`
 * and passes every other prop through, as the real one does.
 */
export function Button({
  variant = 'default',
  size = 'default',
  ...props
}: ComponentProps<'button'> & {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
}) {
  return <button data-slot='button' data-variant={variant} data-size={size} {...props} />
}
