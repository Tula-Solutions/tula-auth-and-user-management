import { defineConfig } from 'bunup'

// One entry per `exports` subpath (package.json › publishConfig.exports).
export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/middleware.ts', 'src/handlers.ts'],
  format: ['esm'],
  // Web platform APIs only: the middleware runs in the Edge runtime on Next.js 15.
  target: 'browser',
  dts: { inferTypes: true },
  // Shipped sources only: see tsconfig.build.json.
  preferredTsconfig: './tsconfig.build.json',
  // Next.js, React, jose and the other Tula packages stay imports; nothing is bundled in.
  packages: 'external',
  // No shared chunks: each entry is one file, so `'use client'` stays at the top of the
  // client entry and nothing of the server entries (which name the secret key) can end up in
  // a file the client entry imports.
  splitting: false,
  jsx: { runtime: 'automatic', development: false },
})
