import { GlobalRegistrator } from '@happy-dom/global-registrator'

// The components' tests need a renderer, which under `bun test` is react-dom on happy-dom.

/**
 * Put happy-dom's globals in place, keeping Bun's own `fetch` and the other web platform
 * classes.
 */
export function registerDom(): void {
  const kept = { fetch, Request, Response, Headers, AbortController, AbortSignal, URL }
  GlobalRegistrator.register({ url: 'http://localhost/' })
  Object.assign(globalThis, kept)
}
