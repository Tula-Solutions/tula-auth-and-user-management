import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Preloaded by bunfig.toml before any test file. The hooks are React's and need a renderer to
// run in; under `bun test` that is react-dom on happy-dom, as for `@tula/react`. Nothing of
// either is in the package: `package.test.ts` reads what the built file imports.
//
// Only what the renderer needs is registered, and `fetch` and the other web platform globals
// stay Bun's own: the journeys hand real `Request`s to the API in process.
const kept = { fetch, Request, Response, Headers, AbortController, AbortSignal, URL }
GlobalRegistrator.register({ url: 'http://localhost/' })
Object.assign(globalThis, kept)

// Tells React that state updates in tests are wrapped in `act` (Testing Library does it).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Loaded after the DOM exists and outside any test: Testing Library registers its own
// `beforeAll` when first imported. It cleans up after each test only when asked.
const { cleanup } = await import('@testing-library/react')

afterEach(() => {
  cleanup()
})
