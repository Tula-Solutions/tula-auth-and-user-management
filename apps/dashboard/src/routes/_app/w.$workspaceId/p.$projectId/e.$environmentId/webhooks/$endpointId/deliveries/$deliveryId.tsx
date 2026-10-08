import { createFileRoute } from '@tanstack/react-router'
import { WebhookDeliveryScreen } from '~/features/webhooks/webhook-delivery-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId/deliveries/$deliveryId'
)({
  component: WebhookDeliveryRoute,
})

function WebhookDeliveryRoute() {
  const { endpointId, deliveryId, ...scope } = Route.useParams()
  return (
    // Keyed: the result of "send again" belongs to the delivery it was asked for.
    <WebhookDeliveryScreen
      key={`${endpointId}:${deliveryId}`}
      scope={scope}
      endpointId={endpointId}
      deliveryId={deliveryId}
    />
  )
}
