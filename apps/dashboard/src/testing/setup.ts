import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Preloaded by bunfig.toml before any test file: gives `bun test` a DOM so screens can be
// rendered with Testing Library. The page's address is where the API serves the app.
GlobalRegistrator.register({ url: 'http://localhost:3003/dashboard/' })

// Tells React that state updates in tests are wrapped in `act` (Testing Library does it).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Loaded after the DOM exists and outside any test: Testing Library registers its own hooks
// when first imported, and cleans up after each test only when asked under `bun:test`.
const { cleanup } = await import('@testing-library/react')
afterEach(() => {
  cleanup()
})
