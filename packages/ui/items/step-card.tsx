'use client'

import { useLocalization } from '@tula-tech/react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** The level of a step card's title: 1 for a page of its own, 2 or 3 inside a page with an h1. */
export type StepCardLevel = 1 | 2 | 3

export interface StepCardProps {
  /** The step's title. Takes the focus when `focusTitle` is set. */
  title: string
  /** A line under the title: where the user is going, or what this step asks. */
  description?: ReactNode
  /**
   * Whether the title takes the focus as the card appears. Set it from the second screen of a
   * flow on (`useScreenChanged`), so that a screen-reader user hears the new step and a
   * keyboard user continues from its top.
   */
  focusTitle?: boolean
  /** The heading level of the title. Defaults to 1. */
  level?: StepCardLevel
  /** Under the content, set apart by a rule: the link to the other screen. */
  footer?: ReactNode
  className?: string
  children?: ReactNode
}

/**
 * One screen of a flow: a titled card, drawn in Tula's style (ink on paper, 10px corners, a
 * quiet shadow) from the app's own shadcn tokens, so it follows whatever theme the app has.
 *
 * It is presentation only: the screens that use it decide what to draw and the flow decides
 * which screen that is.
 */
export function StepCard(props: StepCardProps) {
  const t = useLocalization()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const { focusTitle = false, level = 1 } = props
  useEffect(() => {
    if (focusTitle) {
      title.current?.focus()
    }
  }, [focusTitle])
  const Heading = `h${level}` as const
  return (
    <Card
      role='group'
      aria-labelledby={titleId}
      className={cn(
        '@container/step w-full max-w-[26rem] gap-0 overflow-hidden rounded-lg border border-border bg-card py-0 text-card-foreground ring-0',
        'shadow-[0_1px_2px_rgb(26_26_24/0.05),0_8px_24px_rgb(26_26_24/0.08)] dark:shadow-none dark:ring-1 dark:ring-foreground/5',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300',
        props.className
      )}
    >
      <CardHeader className='gap-1.5 px-5 pt-7 pb-0 @sm/step:px-8 @sm/step:pt-8'>
        <Heading
          ref={title}
          id={titleId}
          tabIndex={-1}
          className='text-balance text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] outline-none'
        >
          {props.title}
        </Heading>
        {props.description ? (
          <p className='text-pretty text-sm leading-relaxed text-muted-foreground'>
            {props.description}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className='grid gap-5 px-5 pt-6 pb-6 @sm/step:px-8 @sm/step:pb-8'>
        {props.children}
      </CardContent>
      {props.footer ? (
        <CardFooter className='justify-center rounded-none border-t border-border bg-muted/50 px-5 pt-4 pb-1 text-center text-sm text-muted-foreground @sm/step:px-8'>
          {props.footer}
        </CardFooter>
      ) : null}
      <p
        className={cn(
          'flex items-center justify-center gap-1.5 px-5 pt-2 pb-3.5 text-xs text-muted-foreground/80',
          props.footer ? 'bg-muted/50' : 'border-t border-border'
        )}
      >
        <svg
          aria-hidden='true'
          viewBox='0 0 16 16'
          className='size-3 shrink-0'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <rect x='3' y='7' width='10' height='6.5' rx='1.5' />
          <path d='M5.5 7V5a2.5 2.5 0 0 1 5 0v2' />
        </svg>
        {t.common.securedBy}
      </p>
    </Card>
  )
}
