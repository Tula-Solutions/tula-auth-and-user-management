import { createFileRoute } from '@tanstack/react-router'
import { UsersScreen } from '~/features/users/users-screen'
import { pageSearch } from '~/lib/search'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/users/')({
  validateSearch: (search: Record<string, unknown>): { q?: string; page?: number } => ({
    ...pageSearch(search),
    ...(typeof search.q === 'string' && search.q !== '' ? { q: search.q } : {}),
    ...(typeof search.q === 'number' ? { q: String(search.q) } : {}),
  }),
  component: UsersRoute,
})

function UsersRoute() {
  const search = Route.useSearch()
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    <UsersScreen
      scope={params}
      q={search.q ?? ''}
      page={search.page ?? 1}
      onSearch={(next) =>
        void navigate({
          search: {
            ...(next.q ? { q: next.q } : {}),
            ...(next.page > 1 ? { page: next.page } : {}),
          },
          replace: next.replace,
        })
      }
    />
  )
}
