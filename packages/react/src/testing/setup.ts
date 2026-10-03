import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Preloaded by bunfig.toml before any test file: gives `bun test` a DOM (window, document,
// events) so components can be rendered with Testing Library. The page has a real-looking URL
// because navigation helpers resolve relative URLs against it.
GlobalRegistrator.register({ url: 'http://localhost:5173/' })

// Tells React that state updates in tests are wrapped in `act` (Testing Library does it).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Testing Library is loaded here, after the DOM exists and outside any test: it registers its
// own `beforeAll` when first imported, which the runner refuses inside a test or a hook. It
// cleans up after each test only when it finds a global `afterEach`; with `bun:test` it has to
// be asked.
const { cleanup } = await import('@testing-library/react')
afterEach(() => {
  cleanup()
})
