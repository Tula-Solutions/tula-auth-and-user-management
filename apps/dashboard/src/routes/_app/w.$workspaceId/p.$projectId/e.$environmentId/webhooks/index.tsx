import { createFileRoute } from '@tanstack/react-router'
import { WebhooksScreen } from '~/features/webhooks/webhooks-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/'
)({
  component: WebhooksRoute,
})

function WebhooksRoute() {
  return <WebhooksScreen scope={Route.useParams()} />
}
