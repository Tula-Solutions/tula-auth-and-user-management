import { defineConfig } from 'bunup'
import { copy } from 'bunup/plugins'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Components run in the browser and during server rendering: web platform APIs only.
  target: 'browser',
  dts: { inferTypes: true },
  // Shipped sources only: see tsconfig.build.json.
  preferredTsconfig: './tsconfig.build.json',
  // React, `@tula/core` and `@tula/contract` stay imports; nothing is bundled in.
  packages: 'external',
  // The production JSX runtime (`react/jsx-runtime`), whatever NODE_ENV the build runs with.
  jsx: { runtime: 'automatic', development: false },
  // `src/index.ts` starts with 'use client' and the bundler keeps the directive at the top of
  // the one output file: everything here uses context, state or effects, and the directive
  // lets a React Server Component import from the package directly.
  // The one stylesheet ships next to the script, as `@tula/react/styles.css`.
  plugins: [copy('src/styles.css')],
})
