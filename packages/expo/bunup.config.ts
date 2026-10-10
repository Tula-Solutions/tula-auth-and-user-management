import { defineConfig } from 'bunup'

export default defineConfig({
  // One file each: the main entry, and the two that import an optional native module.
  entry: ['src/index.ts', 'src/passkeys.ts', 'src/browser.ts'],
  format: ['esm'],
  // Hermes runs what a browser runs: web platform APIs only, no Node or Bun API.
  target: 'browser',
  dts: { inferTypes: true },
  // Shipped sources only: see tsconfig.build.json.
  preferredTsconfig: './tsconfig.build.json',
  // React, React Native, `expo-secure-store` and `@tula/core` stay imports; nothing is
  // bundled in.
  packages: 'external',
  // One file: Metro resolves it without knowing about chunks.
  splitting: false,
})
