import { tabsRuntime } from '../client/tabs'

/**
 * The script that follows the first set of tabs of a page: the whole runtime
 * (`src/client/tabs.ts`), written from the function's own source so that there is one copy of
 * it. It runs while the page is still being parsed, which is what keeps the stacked panels of a
 * page without script from ever being painted for a reader who has script.
 */
export const TABS_SCRIPT = `(${tabsRuntime.toString()})()`

/** The script that follows every later set of tabs: the runtime is there, it enhances the new group. */
export const TABS_CALL = 'window.__docsTabs&&window.__docsTabs()'
