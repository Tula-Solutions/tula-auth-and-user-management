import { afterEach } from 'bun:test'
import { registerDom } from './dom'

// Preloaded by bunfig.toml before any test file. The hooks are React's and need a renderer to
// run in; under `bun test` that is react-dom on happy-dom, as for `@tula/react`. Nothing of
// either is in the package: `package.test.ts` reads what the built file imports. The
// journeys take it away again for as long as they run (`journeys.test.ts`).
registerDom()

// Tells React that state updates in tests are wrapped in `act` (Testing Library does it).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Loaded after the DOM exists and outside any test: Testing Library registers its own
// `beforeAll` when first imported. It cleans up after each test only when asked.
const { cleanup } = await import('@testing-library/react')

afterEach(() => {
  cleanup()
})
