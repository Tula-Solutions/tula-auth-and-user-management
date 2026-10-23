import { createFileRoute } from '@tanstack/react-router'
import { OrganizationDetailScreen } from '~/features/organizations/organization-detail-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/organizations/$organizationId'
)({
  component: OrganizationRoute,
})

function OrganizationRoute() {
  const { organizationId, ...scope } = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    // Keyed: the router keeps the component when only `$organizationId` changes, and a
    // dialog opened for one organization must not act on the next.
    <OrganizationDetailScreen
      key={organizationId}
      scope={scope}
      organizationId={organizationId}
      onGone={() =>
        void navigate({
          to: '/w/$workspaceId/p/$projectId/e/$environmentId/organizations',
          params: scope,
        })
      }
    />
  )
}
