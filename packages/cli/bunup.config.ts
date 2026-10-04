import { defineConfig } from 'bunup'

export default defineConfig({
  // `index` is the programmatic entry (`runCli`), `bin` the executable: it keeps its
  // `#!/usr/bin/env bun` line, which is what lets the installed `tula` import a
  // `tula.config.ts` without a build step.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  target: 'bun',
  dts: { inferTypes: true },
  preferredTsconfig: './tsconfig.build.json',
  // The other Tula packages stay imports; nothing is bundled in.
  packages: 'external',
})
