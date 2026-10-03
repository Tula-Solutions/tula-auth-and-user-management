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
}

interface RuntimeGlobals {
  navigator?: { locks?: LockManagerLike }
  BroadcastChannel?: new (name: string) => ChannelLike
}

/**
 * Read the cross-tab primitives from the runtime's globals, if it has them.
 *
 * Browsers have both. Where one is missing the client simply coordinates less: without locks
 * two tabs can refresh at once (the server's reuse grace period makes that harmless), and
 * without a channel a tab learns of another tab's sign-out on its next refresh.
 *
 * @param globals - The global object to read (the real one unless a test passes its own).
 * @returns The environment.
 */
export function runtimeEnvironment(
  globals: RuntimeGlobals = globalThis as unknown as RuntimeGlobals
): Environment {
  const Channel = globals.BroadcastChannel
  return {
    now: () => Date.now(),
    locks: globals.navigator?.locks,
    createChannel: Channel ? (name) => new Channel(name) : undefined,
  }
}
