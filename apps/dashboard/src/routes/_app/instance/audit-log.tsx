import { createFileRoute } from '@tanstack/react-router'
import { type AuditFilters, AuditLogScreen, auditSearch } from '~/features/audit/audit-log-screen'

export const Route = createFileRoute('/_app/instance/audit-log')({
  validateSearch: (search: Record<string, unknown>): AuditFilters => auditSearch(search),
  component: InstanceAuditRoute,
})

function InstanceAuditRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AuditLogScreen
      scope='instance'
      filters={filters}
      onFilters={(next) => void navigate({ search: next })}
    />
  )
}
