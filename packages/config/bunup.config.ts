import { defineConfig } from 'bunup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Tooling only (the CLI, a deploy script): Node and Bun, never a browser.
  target: 'node',
  dts: { inferTypes: true },
  preferredTsconfig: './tsconfig.build.json',
  // `@tula/contract` and Zod stay imports; nothing is bundled in.
  packages: 'external',
})
