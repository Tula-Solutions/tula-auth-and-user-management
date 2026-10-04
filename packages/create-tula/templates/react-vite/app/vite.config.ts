import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The port is fixed because the API decides by origin which pages may use its cookies: in the
// `local` tier every loopback origin is allowed, elsewhere this origin has to be listed in the
// environment's `urls.allowedOrigins`.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
})
