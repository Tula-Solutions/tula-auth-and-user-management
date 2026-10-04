import { FlaskConical, TriangleAlert } from 'lucide-react'
import { cn } from '~/lib/utils'

/** The two kinds of environment a project has. */
export type EnvironmentKind = 'development' | 'production'

/** The name of an environment kind as the dashboard writes it. */
export const KIND_LABEL: Record<EnvironmentKind, string> = {
  development: 'Development',
  production: 'Production',
}

/**
 * Which kind of environment is being acted on. Production is told apart by its words and its
 * icon as well as its colour.
 *
 * @param props - `kind`: the environment's kind.
 * @returns The badge.
 */
export function EnvironmentBadge({
  kind,
  className,
}: {
  kind: EnvironmentKind
  className?: string
}) {
  const production = kind === 'production'
  const Icon = production ? TriangleAlert : FlaskConical
  return (
    <span
      data-environment-kind={kind}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        production
          ? 'border-destructive bg-destructive-surface text-destructive'
          : 'border-input text-muted-foreground',
        className
      )}
    >
      <Icon aria-hidden='true' className='size-3.5' />
      {production ? 'Production · live users' : 'Development'}
    </span>
  )
}
