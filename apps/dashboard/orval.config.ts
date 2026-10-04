import { defineConfig } from 'orval'

// The dashboard's API hooks and types, generated from the contract's OpenAPI snapshot
// (`bun run dashboard:generate`). Only the operations a dashboard session may call are kept:
// `/v1/admin/*` and `/v1/instance/*` (scripts/openapi-filter.ts).
export default defineConfig({
  dashboard: {
    input: {
      target: '../../packages/contract/openapi.json',
      override: { transformer: './scripts/openapi-filter.ts' },
    },
    output: {
      mode: 'single',
      target: './src/api/generated/api.gen.ts',
      client: 'react-query',
      httpClient: 'fetch',
      clean: false,
      override: {
        mutator: { path: './src/api/mutator.ts', name: 'dashboardFetch' },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
})
