import { GlobalRegistrator } from '@happy-dom/global-registrator'

// The hooks' tests need a renderer, which under `bun test` is react-dom on happy-dom. The
// journeys must run without one: an app has no `document`, and a client that reached for it
// would work here and fail on a device.

/**
 * Put happy-dom's globals in place, keeping Bun's own `fetch` and the other web platform
 * classes: the journeys hand real `Request`s to the API in process.
 */
export function registerDom(): void {
  const kept = { fetch, Request, Response, Headers, AbortController, AbortSignal, URL }
  GlobalRegistrator.register({ url: 'http://localhost/' })
  Object.assign(globalThis, kept)
}

/** What a browser has and an app does not, and a client could be tempted to read. */
export const BROWSER_GLOBALS = [
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'BroadcastChannel',
] as const

/**
 * Take the browser's globals out of the process for a while. They are put back as the same
 * objects: the renderer and Testing Library hold on to the document they were loaded with,
 * so registering a new one would leave the hooks' tests drawing into nothing.
 *
 * @returns A function that puts them back.
 */
export function hideDom(): () => void {
  const hidden = new Map<string, PropertyDescriptor>()
  for (const name of BROWSER_GLOBALS) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    if (descriptor && Reflect.deleteProperty(globalThis, name)) {
      hidden.set(name, descriptor)
    }
  }
  return () => {
    for (const [name, descriptor] of hidden) {
      Object.defineProperty(globalThis, name, descriptor)
    }
  }
}
