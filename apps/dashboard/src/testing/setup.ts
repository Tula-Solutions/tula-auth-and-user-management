import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Preloaded by bunfig.toml before any test file: gives `bun test` a DOM so screens can be
// rendered with Testing Library. The page's address is where the API serves the app.
GlobalRegistrator.register({ url: 'http://localhost:3003/dashboard/' })

// Tells React that state updates in tests are wrapped in `act` (Testing Library does it).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Loaded after the DOM exists and outside any test: Testing Library registers its own hooks
// when first imported, and cleans up after each test only when asked under `bun:test`.
const { cleanup, configure } = await import('@testing-library/react')

// How long `findBy*` and `waitFor` wait before they give up. Nothing in these tests waits for
// a clock: every wait is for work (a render, an answer of the fake API) that ends as soon as
// the machine gets to it. Testing Library's default of one second is a guess at how long that
// work takes, and a loaded CI runner, on the first render of the whole app in the process,
// takes longer. The bound only decides how long a test that is really broken takes to say so;
// it stays below the per-test timeout (`--timeout 30000` in the package's test scripts; Bun
// reads none from bunfig.toml) so that the failure is the query's own message and not
// "timed out".
configure({ asyncUtilTimeout: 10_000 })

afterEach(() => {
  cleanup()
})
