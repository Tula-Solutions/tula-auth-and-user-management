import { printable } from '~/lib/printable'
import { cn } from '~/lib/utils'

/**
 * An endpoint's address as the screens say it, in text and in a control's name: with every
 * character nobody can see written out ({@link printable}).
 *
 * It is also what an operator types to confirm a destructive action in production: what is
 * asked for is what is shown, and what is typed is compared with that. The address itself
 * could not be typed when it holds such a character, and asking for it would mean asking for
 * something the operator cannot read.
 *
 * @param url - The address as the server holds it.
 * @returns The address as shown.
 */
export function shownAddress(url: string): string {
  return printable(url)
}

/**
 * An endpoint's address, wherever one is shown: written out by {@link shownAddress}, kept
 * apart from the direction of the text around it (and its own direction fixed, so a
 * right-to-left letter in a path cannot reorder the host), and free to wrap anywhere, since
 * an address has no spaces to wrap at.
 *
 * Server text: rendered as text, never a link.
 *
 * @param props - `url`: the address as the server holds it; `className`: extra classes.
 * @returns The address.
 */
export function Address({ url, className }: { url: string; className?: string }) {
  return (
    <bdi dir='ltr' className={cn('font-mono break-all', className)}>
      {shownAddress(url)}
    </bdi>
  )
}
