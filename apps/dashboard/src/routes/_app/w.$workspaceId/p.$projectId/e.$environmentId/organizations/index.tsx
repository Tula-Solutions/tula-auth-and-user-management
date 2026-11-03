import { createFileRoute } from '@tanstack/react-router'
import { OrganizationsScreen } from '~/features/organizations/organizations-screen'
import { pageSearch } from '~/lib/search'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/organizations/'
)({
  validateSearch: (search: Record<string, unknown>): { q?: string; page?: number } => ({
    ...pageSearch(search),
    ...(typeof search.q === 'string' && search.q !== '' ? { q: search.q } : {}),
    ...(typeof search.q === 'number' ? { q: String(search.q) } : {}),
  }),
  component: OrganizationsRoute,
})

function OrganizationsRoute() {
  const search = Route.useSearch()
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    <OrganizationsScreen
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
