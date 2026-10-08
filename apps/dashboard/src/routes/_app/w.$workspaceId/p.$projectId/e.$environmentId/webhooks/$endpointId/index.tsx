import { createFileRoute } from '@tanstack/react-router'
import {
  type DeliveryFilters,
  deliverySearch,
  WebhookEndpointScreen,
} from '~/features/webhooks/webhook-endpoint-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId/'
)({
  validateSearch: (search: Record<string, unknown>): DeliveryFilters => deliverySearch(search),
  component: WebhookEndpointRoute,
})

function WebhookEndpointRoute() {
  const { endpointId, ...scope } = Route.useParams()
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    // Keyed: the router keeps the component when only `$endpointId` changes, and a dialog
    // opened for one endpoint (its new secret, a confirmation) must not act on the next.
    <WebhookEndpointScreen
      key={endpointId}
      scope={scope}
      endpointId={endpointId}
      filters={filters}
      onFilters={(next) => void navigate({ search: next })}
      onGone={() =>
        void navigate({
          to: '/w/$workspaceId/p/$projectId/e/$environmentId/webhooks',
          params: scope,
        })
      }
    />
  )
}
