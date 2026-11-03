import { createFileRoute } from '@tanstack/react-router'
import { SetupScreen } from '~/features/setup/setup-screen'

// Public: a setup link opens it with no account. The token is in the address's fragment, which
// the screen moves into memory; the route has no `beforeLoad` and no search to validate.
export const Route = createFileRoute('/setup')({
  component: SetupScreen,
})
