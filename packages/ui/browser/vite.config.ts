import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The browser harness of Tula UI (TULA-127): the registry's organization items drawn by a real
// browser, so that axe sees them in both colour schemes, which Testing Library (no layout, no
// styles) cannot. Not shipped, not part of the registry: `e2e/tests/tula-ui.spec.ts` drives it.
//
// It stands where a developer's app stands. The items import shadcn's primitives from
// `@/components/ui/*`; here those are the real ones the dashboard already holds (written by
// shadcn's CLI), not the test doubles of this package's unit tests, because a double has no
// classes and so no colour to check. The theme is the registry's own `theme` item, read from
// `r/theme.json`, never copied here.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const dashboardUi = here('../../../apps/dashboard/src')

interface ThemeItem {
  cssVars: { light: Record<string, string>; dark: Record<string, string> }
}

/** The declarations of one scheme, as the `theme` item of the registry writes them. */
function declarations(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ')
}

/**
 * Write the registry's theme into the page: shadcn's variables in the light scheme, and in the
 * dark one under the media query the harness is tested with (`page.emulateMedia`).
 */
function tulaTheme(): Plugin {
  const item = JSON.parse(readFileSync(here('../r/theme.json'), 'utf8')) as ThemeItem
  return {
    name: 'tula-ui-theme',
    transformIndexHtml: () => [
      {
        tag: 'style',
        injectTo: 'head',
        children:
          `:root { color-scheme: light dark; ${declarations(item.cssVars.light)} } ` +
          `@media (prefers-color-scheme: dark) { :root { ${declarations(item.cssVars.dark)} } }`,
      },
    ],
  }
}

export default defineConfig({
  root: here('.'),
  // Served by the e2e fixture under this path (e2e/server.ts).
  base: '/__ui/',
  plugins: [react(), tailwindcss(), tulaTheme()],
  resolve: {
    alias: {
      '@/components/ui': `${dashboardUi}/components/ui`,
      '@/components/tula': here('../items'),
      '@/lib/utils': `${dashboardUi}/lib/utils.ts`,
      // The bare specifier shadcn's primitives import `cn` from (AGENTS.md, "apps/dashboard/src/components/ui").
      cn: `${dashboardUi}/lib/utils.ts`,
    },
  },
  build: { outDir: here('dist'), emptyOutDir: true, sourcemap: false },
})
