import { tulaMiddleware } from '@tula-tech/nextjs/middleware'

// The Next.js access rules shown in docs/organizations.md. Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

// #region nextjs-proxy
// proxy.ts (middleware.ts before Next.js 16)
export const proxy = tulaMiddleware({
  publicRoutes: ['/', '/pricing'],
  access: [
    // The active organization's role must hold this exact permission key.
    { routes: '/billing(.*)', permission: 'org:billing:read' },
    // Or be this role.
    { routes: '/admin(.*)', role: 'admin' },
  ],
  // Pages go here; an API route or a write gets a 403 JSON error instead.
  forbiddenUrl: '/no-access',
})
// #endregion
