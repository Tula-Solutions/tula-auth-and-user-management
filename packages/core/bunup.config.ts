import { defineConfig } from 'bunup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Browsers, Node, Bun and edge runtimes: the output uses web platform APIs only.
  target: 'browser',
  dts: { inferTypes: true },
  // `@tula/contract` stays an import (of its Zod-free entry points); nothing is bundled in.
  packages: 'external',
})
