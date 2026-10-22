import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { resolveOutDir } from './src/lib/paths'

// Builds the one script and stylesheet every page loads (src/client/main.ts). The pages
// themselves are not built by Vite: `scripts/build.ts` renders them to static HTML afterwards,
// reading the manifest this build writes. This file runs under Node (Vite's own launcher), so
// it may not use Bun's APIs or import the site's sources, except `src/lib/paths.ts`, which is
// Node-only on purpose (the one place that decides where the build may write).
const normalize = (value: string) => {
  const trimmed = value.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? '/' : `/${trimmed}/`
}

export default defineConfig({
  base: normalize(process.env.DOCS_BASE ?? '/'),
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      cn: fileURLToPath(new URL('./src/lib/utils.ts', import.meta.url)),
    },
  },
  build: {
    outDir: resolveOutDir(),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    modulePreload: false,
    rollupOptions: { input: fileURLToPath(new URL('./src/client/main.ts', import.meta.url)) },
  },
})
