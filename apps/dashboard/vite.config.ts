import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { originForApi } from './src/lib/dev-proxy'

// The API serves the build at /dashboard under a strict Content-Security-Policy (ADR 0032):
// every script and stylesheet is a file of this origin, so nothing here may inline one.
// In development the dev server proxies /v1 to the local API, which keeps the session cookie
// same-origin exactly as it is in the image.
const API_URL = process.env.TULA_API_URL ?? 'http://localhost:3003'
const DEV_PORT = 5175

export default defineConfig({
  base: '/dashboard/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    // No inline <script> for the module-preload polyfill, and no small asset inlined as a
    // `data:` URL into a stylesheet: the CSP allows neither an inline script nor a data: font.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/v1': {
        target: API_URL,
        changeOrigin: false,
        // The API takes a dashboard request from its own origin only (or CORS_ORIGINS). The
        // dev page's own calls are presented as that origin; any other origin is passed on
        // untouched and refused there (src/lib/dev-proxy.ts).
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyRequest, request) => {
            const origin = originForApi(request.headers.origin, DEV_PORT, new URL(API_URL).origin)
            if (origin !== undefined) {
              proxyRequest.setHeader('origin', origin)
            }
          })
        },
      },
    },
  },
})
