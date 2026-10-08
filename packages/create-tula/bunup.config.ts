import { defineConfig } from 'bunup'

export default defineConfig({
  // `index` is the programmatic entry (`scaffold`), `bin` the executable with its
  // `#!/usr/bin/env bun` line. The templates are plain files beside `dist`, not bundled.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  target: 'bun',
  dts: { inferTypes: true },
  preferredTsconfig: './tsconfig.build.json',
  packages: 'external',
})
