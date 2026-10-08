import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$workspaceId/p/$projectId/e/$environmentId/users',
      params,
      replace: true,
    })
  },
})
