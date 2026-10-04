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
    <UserDetailScreen
      scope={scope}
      userId={userId}
      onGone={() =>
        void navigate({ to: '/w/$workspaceId/p/$projectId/e/$environmentId/users', params: scope })
      }
    />
  )
}
