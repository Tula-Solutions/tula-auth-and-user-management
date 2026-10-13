import { createFileRoute } from '@tanstack/react-router'
import { ProposalsScreen } from '~/features/proposals/proposals-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/proposals'
)({
  component: ProposalsScreen,
})
