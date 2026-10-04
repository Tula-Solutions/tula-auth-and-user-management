import { createFileRoute } from '@tanstack/react-router'
import { UserDetailScreen } from '~/features/users/user-detail-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/users/$userId'
)({
  component: UserRoute,
})

function UserRoute() {
  const { userId, ...scope } = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    // Keyed: the router keeps the component when only `$userId` changes, and a password
    // typed for one user, or a confirmation opened for them, must not act on the next.
    <UserDetailScreen
      key={userId}
      scope={scope}
      userId={userId}
      onGone={() =>
        void navigate({ to: '/w/$workspaceId/p/$projectId/e/$environmentId/users', params: scope })
      }
    />
  )
}
