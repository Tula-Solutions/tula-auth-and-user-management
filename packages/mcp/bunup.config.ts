import { defineConfig } from 'bunup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'bun',
  dts: { inferTypes: true },
  preferredTsconfig: './tsconfig.build.json',
  // The MCP SDK, Zod and the admin client stay imports; nothing is bundled in.
  packages: 'external',
})
