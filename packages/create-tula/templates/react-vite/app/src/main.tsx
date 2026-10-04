import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import '@tula/react/styles.css'
import './app.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
