import { Link, useParams } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { EnvironmentSection } from './sections'

/**
 * A link from one screen of an environment to another screen of the same environment: the
 * workspace, project and environment are the address's own.
 *
 * @param props - `to`: the screen's route; `children`: the link's text.
 * @returns The link; outside an environment route (a screen rendered alone) only its text.
 */
export function EnvironmentLink({
  to,
  children,
}: {
  to: EnvironmentSection['to']
  children: ReactNode
}) {
  const params = useParams({ strict: false }) as Partial<
    Record<'workspaceId' | 'projectId' | 'environmentId', string>
  >
  const { workspaceId, projectId, environmentId } = params
  if (!workspaceId || !projectId || !environmentId) {
    return <>{children}</>
  }
  return (
    <Link
      to={to}
      params={{ workspaceId, projectId, environmentId }}
      className='text-link underline underline-offset-4'
    >
      {children}
    </Link>
  )
}
