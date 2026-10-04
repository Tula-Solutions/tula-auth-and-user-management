import { createFileRoute } from '@tanstack/react-router'
import { SigningKeysScreen } from '~/features/keys/signing-keys-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/signing-keys'
)({
  component: SigningKeysScreen,
})
