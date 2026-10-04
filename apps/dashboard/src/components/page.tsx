import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react'
import { cn } from '~/lib/utils'

/** How the shell tells a screen's heading that the operator has just navigated. */
export interface NavigationFocus {
  /** Goes up by one on every change of address; 0 on the first load. */
  token: number
  /** The last token a heading took the focus for, so that each navigation moves it once. */
  handled: { current: number }
}

/**
 * Provided by the shell. Without it (a screen rendered alone, as in a test) a heading never
 * takes the focus by itself.
 */
export const NavigationFocusContext = createContext<NavigationFocus>({
  token: 0,
  handled: { current: 0 },
})

/**
 * A screen's heading, with its description and actions.
 *
 * The heading takes the focus once after each navigation (never on the first load), so a
 * keyboard or screen-reader user starts at the new content. It does so itself, when it
 * appears: a screen's code and data may arrive after the address has changed.
 *
 * @param props - `title`, optional `description` and `actions`.
 * @returns The header.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const navigation = useContext(NavigationFocusContext)
  useEffect(() => {
    if (navigation.token !== navigation.handled.current) {
      navigation.handled.current = navigation.token
      heading.current?.focus()
    }
  }, [navigation])
  return (
    <div className='flex flex-wrap items-start justify-between gap-3'>
      <div className='flex min-w-0 flex-col gap-1'>
        <h1
          ref={heading}
          tabIndex={-1}
          className='text-2xl font-semibold tracking-tight outline-none'
        >
          {title}
        </h1>
        {description ? (
          <p className='max-w-prose text-sm text-muted-foreground'>{description}</p>
        ) : null}
      </div>
      {actions ? <div className='flex flex-wrap gap-2'>{actions}</div> : null}
    </div>
  )
}

/**
 * A titled block of a screen, on a card.
 *
 * @param props - `title`, optional `description`, `actions` and the content.
 * @returns The section.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground',
        className
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-base font-semibold'>{title}</h2>
          {description ? (
            <p className='max-w-prose text-sm text-muted-foreground'>{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}
