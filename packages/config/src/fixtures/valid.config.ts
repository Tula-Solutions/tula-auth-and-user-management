import { defineConfig, env } from '../index'

export default defineConfig({
  environments: {
    dev: {
      kind: 'development',
      settings: { app: { name: 'Northline (dev)' } },
      providers: {
        github: { clientId: 'gh-dev', clientSecret: env('GITHUB_CLIENT_SECRET') },
      },
    },
  },
})
