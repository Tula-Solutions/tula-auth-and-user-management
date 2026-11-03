import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { resolveBase, resolveOutDir } from './src/lib/paths'

// Builds the one script and stylesheet every page loads (src/client/main.ts) and the playground
// island's entry, which only the pages with a playground load. The pages
// themselves are not built by Vite: `scripts/build.ts` renders them to static HTML afterwards,
// reading the manifest this build writes. This file runs under Node (Vite's own launcher), so
// it may not use Bun's APIs or import the site's sources, except `src/lib/paths.ts`, which is
// Node-only on purpose (the one place that decides where the build may write and under which
// base path it is served).
export default defineConfig({
  base: resolveBase(),
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      cn: fileURLToPath(new URL('./src/lib/utils.ts', import.meta.url)),
      // The client API's generated types and route table, which `@tula-tech/core` does not export.
      '~core-api': fileURLToPath(
        new URL('../../packages/core/src/generated/api.gen.ts', import.meta.url)
      ),
    },
  },
  build: {
    outDir: resolveOutDir(),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    modulePreload: false,
    // The playground island is one lazy chunk of about 610 kB (185 kB gzipped: React, the
    // client, the components and the sandbox), loaded only on a page with a playground. The
    // limit sits just above it, so a chunk that grows past it warns again.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // Two entries. `main` is on every page. `playground` is added by the build to the pages
      // that hold a playground and to no other: its script is a few hundred bytes and loads
      // the island (React, the client, the components, the sandbox) as a chunk of its own,
      // only when a placeholder is near the viewport.
      // A bundler warns that it drops the "use client" directive of an icon package: the
      // directive is for a framework that splits server and client components, and this
      // bundle is all client. That one message is muted; every other warning still prints.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) {
          return
        }
        warn(warning)
      },
      input: {
        main: fileURLToPath(new URL('./src/client/main.ts', import.meta.url)),
        playground: fileURLToPath(new URL('./src/client/playground.ts', import.meta.url)),
      },
    },
  },
})
