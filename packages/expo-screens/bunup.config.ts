import { defineConfig } from 'bunup'

export default defineConfig([
  {
    name: 'app',
    // One file: the entry point that loads this package's own native module.
    entry: ['src/index.ts'],
    format: ['esm'],
    // Hermes runs what a browser runs: web platform APIs only, no Node or Bun API.
    target: 'browser',
    dts: { inferTypes: true },
    // Shipped sources only: see tsconfig.build.json.
    preferredTsconfig: './tsconfig.build.json',
    // React, React Native, `expo`, `@tula/core` and the contract's theme stay imports;
    // nothing is bundled in.
    packages: 'external',
    // One file: Metro resolves it without knowing about chunks.
    splitting: false,
  },
  {
    name: 'plugin',
    // The config plugin runs in Node when an app's configuration is read, and Expo loads a
    // plugin with `require`: CommonJS, in a file of its own that imports nothing. The
    // same file as a module is for an `import` of it: Node cannot see the names a bundled
    // CommonJS file exports. The plugin keeps no state, so two copies are one.
    entry: ['src/plugin.ts'],
    format: ['esm', 'cjs'],
    // No Node API is used, so the neutral target: for `node` the bundler adds a
    // `require('node:module')` of its own that nothing reads.
    target: 'browser',
    dts: { inferTypes: true },
    preferredTsconfig: './tsconfig.build.json',
    packages: 'external',
    splitting: false,
    // The first build has emptied the directory; this one adds to it.
    clean: false,
  },
])
