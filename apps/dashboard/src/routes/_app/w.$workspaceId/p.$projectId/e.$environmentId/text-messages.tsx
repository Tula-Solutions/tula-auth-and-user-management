import { createFileRoute } from '@tanstack/react-router'
import { SmsScreen } from '~/features/sms/sms-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/text-messages'
)({
  component: SmsScreen,
})
