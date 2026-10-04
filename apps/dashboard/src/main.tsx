import './lib/zod-csp'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, createAppRouter, createQueryClient } from './app'
import './styles.css'

const container = document.getElementById('root')
if (container !== null) {
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient)
  createRoot(container).render(
    <StrictMode>
      <App queryClient={queryClient} router={router} />
    </StrictMode>
  )
}
