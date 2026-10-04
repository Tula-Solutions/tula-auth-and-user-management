/**
 * The part of the Web Locks API the client uses: one named, exclusive lock shared by every tab
 * of an origin.
 */
export interface LockManagerLike {
  /**
   * Run `callback` while holding the lock `name`, waiting for it first.
   *
   * @param name - The lock's name.
   * @param options - `signal` gives up waiting; it has no effect once the lock is held.
   * @param callback - What to do while holding the lock.
   * @returns What `callback` returned.
   */
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<T>
  ): Promise<T>
}

/** The part of `BroadcastChannel` the client uses: messages between tabs of one origin. */
export interface ChannelLike {
  /** @param message - Delivered to every other tab's channel of the same name. */
  postMessage(message: unknown): void
  /** Called with each message another tab posts. */
  onmessage: ((event: { data: unknown }) => void) | null
  /** Stop receiving. A channel that is only posted to once is closed right after. */
  close?(): void
}

/**
 * The part of `localStorage` the client uses, for one thing only: the binding of an emailed
 * sign-in link, which a new tab of the same browser has to be able to read.
 */
export interface LinkStorageLike {
  /** @returns The stored value, or `null`. */
  getItem(key: string): string | null
  /** @param value - Stored under `key`, replacing what was there. */
  setItem(key: string, value: string): void
  /** @param key - The entry to delete. */
  removeItem(key: string): void
  /** How many entries the storage holds, to find the client's own expired ones. */
  readonly length: number
  /** @returns The name of the `index`-th entry, or `null`. */
  key(index: number): string | null
}

/** The page's address, as far as the client reads and rewrites it. */
export interface PageLike {
  /** @returns The page's full URL, fragment included. */
  url(): string
  /**
   * Replace the address shown for the page without loading anything
   * (`history.replaceState`).
   *
   * @param url - The new URL.
   */
  replaceUrl(url: string): void
  /**
   * Send the page somewhere else (`location.assign`). Absent where there is nothing to
   * navigate: the caller is then handed the URL instead.
   *
   * @param url - Where to go.
   */
  assign?(url: string): void
}

/**
 * What the client takes from the runtime besides `fetch`. Tests pass fakes; a real client uses
 * {@link runtimeEnvironment}.
 */
export interface Environment {
  /** Current time in epoch milliseconds. */
  now(): number
  /** The Web Locks manager, when the runtime has one. */
  locks: LockManagerLike | undefined
  /** Opens a channel to the origin's other tabs, when the runtime can. */
  createChannel: ((name: string) => ChannelLike) | undefined
  /**
   * Storage shared by the tabs of one browser, when the runtime has it and allows it. Used for
   * an emailed link's binding and nothing else: never a token, never an attempt's secret.
   */
  linkStorage: LinkStorageLike | undefined
  /**
   * Storage one tab keeps across a navigation and no other tab can read (`sessionStorage`).
   * Holds the binding of an OAuth round trip while the tab is at the provider (ADR 0026): not a
   * token, and not an attempt's secret.
   */
  tabStorage: LinkStorageLike | undefined
  /** The page's address, in a browser. */
  page: PageLike | undefined
  /**
   * Run `callback` once after `ms` milliseconds.
   *
   * @returns A function that cancels it.
   */
  setTimer(callback: () => void, ms: number): () => void
}

interface RuntimeGlobals {
  navigator?: { locks?: LockManagerLike }
  BroadcastChannel?: new (name: string) => ChannelLike
  localStorage?: LinkStorageLike
  sessionStorage?: LinkStorageLike
  location?: { href: string; assign?(url: string): void }
  history?: { state: unknown; replaceState(state: unknown, unused: string, url: string): void }
}

/** `localStorage`, when reading the property does not throw (it does in some sandboxed frames). */
function linkStorageOf(globals: RuntimeGlobals): LinkStorageLike | undefined {
  try {
    return globals.localStorage
  } catch {
    return undefined
  }
}

/** `sessionStorage`, when reading the property does not throw. */
function tabStorageOf(globals: RuntimeGlobals): LinkStorageLike | undefined {
  try {
    return globals.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Read the cross-tab primitives from the runtime's globals, if it has them.
 *
 * Browsers have both. Where one is missing the client simply coordinates less: without locks
 * two tabs can refresh at once (the server's reuse grace period makes that harmless), and
 * without a channel a tab learns of another tab's sign-out on its next refresh. Without
 * `localStorage` an emailed sign-in link cannot be honoured (the code in the same email can).
 *
 * @param globals - The global object to read (the real one unless a test passes its own).
 * @returns The environment.
 */
export function runtimeEnvironment(
  globals: RuntimeGlobals = globalThis as unknown as RuntimeGlobals
): Environment {
  const Channel = globals.BroadcastChannel
  const { location, history } = globals
  return {
    now: () => Date.now(),
    locks: globals.navigator?.locks,
    createChannel: Channel ? (name) => new Channel(name) : undefined,
    linkStorage: linkStorageOf(globals),
    tabStorage: tabStorageOf(globals),
    page:
      location && history
        ? {
            url: () => location.href,
            replaceUrl: (url) => history.replaceState(history.state, '', url),
            assign: (url) => location.assign?.(url),
          }
        : undefined,
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
  }
}
