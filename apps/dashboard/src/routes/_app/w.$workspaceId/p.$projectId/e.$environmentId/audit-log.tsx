import { createFileRoute } from '@tanstack/react-router'
import { type AuditFilters, AuditLogScreen, auditSearch } from '~/features/audit/audit-log-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/audit-log'
)({
  validateSearch: (search: Record<string, unknown>): AuditFilters => auditSearch(search),
  component: AuditRoute,
})

function AuditRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AuditLogScreen
      scope='environment'
      filters={filters}
      onFilters={(next) => void navigate({ search: next })}
    />
  )
}
