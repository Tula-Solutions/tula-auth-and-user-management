import { defineConfig } from 'bunup'

export default defineConfig({
  // `browser.ts` is what the `browser` export condition resolves to: a module that refuses to
  // load, so a bundle for a web page fails loudly instead of shipping a secret key.
  entry: ['src/index.ts', 'src/browser.ts'],
  format: ['esm'],
  // Any server runtime: the output uses web platform APIs (`fetch`, `AbortController`) only.
  target: 'browser',
  dts: { inferTypes: true },
  preferredTsconfig: './tsconfig.build.json',
  // `@tula/contract` stays an import (of its Zod-free entry points); nothing is bundled in.
  packages: 'external',
})
