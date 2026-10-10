import type {
  ChannelLike,
  Environment,
  LinkStorageLike,
  LockManagerLike,
  PageLike,
} from '../environment'
import type { Schemas } from '../generated/api.gen'
import type { PasskeyGlobals, PasskeyProvider } from '../passkey'
import type { FetchLike } from '../types'

/** A publishable key that passes the client's shape check. */
export const TEST_KEY = 'tula_pk_dev_unit00000000000000000000000000'

/** The API address the unit tests' clients call. Nothing listens there. */
export const TEST_BASE_URL = 'https://auth.test'

/** One request the fake API received. */
export interface RecordedRequest {
  method: string
  /** Path and query, without the origin. */
  path: string
  headers: Headers
  /** The parsed JSON body, or `undefined` when there was none. */
  body: unknown
}

type Handler = (request: RecordedRequest, raw: Request) => Response | Promise<Response>

/** A promise a test settles by hand, to hold a response while something else happens. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/** @returns A promise with its `resolve` and `reject` exposed. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * @param status - HTTP status.
 * @param body - JSON body.
 * @param headers - Extra response headers.
 * @returns The response.
 */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * @param status - HTTP status.
 * @param code - Contract error code.
 * @param extra - `params`, `errors` or a `detail` for the envelope.
 * @param headers - Extra response headers.
 * @returns An error response in the contract's envelope.
 */
export function failure(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Response {
  return json(status, { status, code, detail: `detail of ${code}`, ...extra }, headers)
}

/**
 * A fake API: routes by `METHOD /path`, records every request, and answers with whatever the
 * test registered. An unregistered route is a test bug and answers 599.
 */
export interface FakeApi {
  fetch: FetchLike
  requests: RecordedRequest[]
  /** Register (or replace) the handler for `METHOD /path`. */
  on(route: string, handler: Handler): void
  /** @returns The requests received for `METHOD /path`. */
  calls(route: string): RecordedRequest[]
}

/** @returns A fake API with no routes. */
export function fakeApi(): FakeApi {
  const handlers = new Map<string, Handler>()
  const requests: RecordedRequest[] = []
  const routeOf = (request: RecordedRequest) => `${request.method} ${request.path}`
  return {
    requests,
    on(route, handler) {
      handlers.set(route, handler)
    },
    calls: (route) => requests.filter((request) => routeOf(request) === route),
    async fetch(raw) {
      const url = new URL(raw.url)
      const text = await raw.clone().text()
      const recorded: RecordedRequest = {
        method: raw.method,
        path: url.pathname + url.search,
        headers: raw.headers,
        body: text === '' ? undefined : JSON.parse(text),
      }
      requests.push(recorded)
      const handler = handlers.get(routeOf(recorded))
      return handler ? handler(recorded, raw) : failure(599, 'internal')
    },
  }
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * An unsigned token shaped like the API's access tokens, valid for `lifetimeSeconds` on the
 * server's clock (which is deliberately not the test's clock: the client must not compare them).
 *
 * @param label - Makes the token unique and recognisable in assertions.
 * @param lifetimeSeconds - `exp - iat`.
 * @returns The token.
 */
export function accessToken(label: string, lifetimeSeconds = 60): string {
  const iat = 1_900_000_000
  const header = base64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ sub: 'user_1', iat, exp: iat + lifetimeSeconds }))
  return `${header}.${payload}.${label}`
}

/**
 * @param label - Names the access token.
 * @param overrides - Fields to change, e.g. `refreshToken` for a non-web client.
 * @returns Session tokens as the API returns them.
 */
export function sessionTokens(
  label: string,
  overrides: Partial<Schemas['SessionTokens']> = {}
): Schemas['SessionTokens'] & { accessToken: string; accessTokenExpiresAt: string } {
  return {
    sessionId: 'session_1',
    accessToken: accessToken(label),
    accessTokenExpiresAt: '2030-01-01T00:01:00.000Z',
    ...overrides,
  }
}

/** A user as `/v1/client/me` returns it: one with an address, as every test means unless it says otherwise. */
export const TEST_USER: Schemas['CurrentUser'] & { email: string } = {
  id: 'user_1',
  email: 'maya@northline.app',
  emailVerifiedAt: '2030-01-01T00:00:00.000Z',
  firstName: 'Maya',
  lastName: null,
  bannedAt: null,
  lastSignInAt: null,
  createdAt: '2030-01-01T00:00:00.000Z',
  hasPassword: true,
}

/** A clock a test moves by hand. */
export interface ManualClock {
  now(): number
  advance(ms: number): void
}

/** @returns A clock starting at an arbitrary instant. */
export function manualClock(): ManualClock {
  let now = 1_000_000_000_000
  return {
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

/**
 * Web Locks, as far as the client uses them: exclusive, first come first served, and a waiter
 * can give up through its signal. One instance stands for one origin, shared by its "tabs".
 */
export interface FakeLocks extends LockManagerLike {
  /** Names requested so far, in order. */
  requested: string[]
  /** How many requests are waiting for a lock right now. */
  waiting(): number
}

/** @returns A lock manager shared by every client it is given to. */
export function fakeLocks(): FakeLocks {
  const tails = new Map<string, Promise<unknown>>()
  const requested: string[] = []
  let waiting = 0
  return {
    requested,
    waiting: () => waiting,
    request<T>(
      name: string,
      options: { signal?: AbortSignal },
      callback: () => Promise<T>
    ): Promise<T> {
      requested.push(name)
      const previous = tails.get(name) ?? Promise.resolve()
      waiting += 1
      const run = new Promise<T>((resolve, reject) => {
        let abandoned = false
        const abandon = () => {
          abandoned = true
          waiting -= 1
          reject(new DOMException('The lock request was aborted', 'AbortError'))
        }
        options.signal?.addEventListener('abort', abandon, { once: true })
        previous.then(() => {
          if (abandoned) {
            return
          }
          options.signal?.removeEventListener('abort', abandon)
          waiting -= 1
          callback().then(resolve, reject)
        })
      })
      // The next waiter runs when this one has finished, or at once if it gave up waiting.
      tails.set(
        name,
        previous.then(() => run.then(noop, noop))
      )
      return run
    },
  }
}

function noop(): void {
  // Keeps the lock queue moving whatever the holder's outcome.
}

/** Every tab's channel of one origin. A message reaches every channel but the sender's. */
export interface FakeChannelHub {
  createChannel(name: string): ChannelLike
  /** Every message posted, in order. */
  posted: unknown[]
  /** Deliver the messages posted so far (when the hub was created with `manual`). */
  flush(): void
}

/**
 * @param mode - `immediate` delivers synchronously, as a same-process test wants; `manual`
 *   holds messages until `flush()`, to test what happens before one arrives.
 * @returns The hub.
 */
export function fakeChannelHub(mode: 'immediate' | 'manual' = 'immediate'): FakeChannelHub {
  const channels: { name: string; channel: ChannelLike }[] = []
  const posted: unknown[] = []
  let held: (() => void)[] = []
  return {
    posted,
    flush() {
      const deliveries = held
      held = []
      for (const deliver of deliveries) {
        deliver()
      }
    },
    createChannel(name) {
      const channel: ChannelLike = {
        onmessage: null,
        postMessage(message) {
          posted.push(message)
          // Structured clone, as a real channel does: the receiver gets a copy.
          const data = structuredClone(message)
          const deliver = () => {
            for (const other of channels) {
              if (other.name === name && other.channel !== channel) {
                other.channel.onmessage?.({ data })
              }
            }
          }
          if (mode === 'immediate') {
            deliver()
          } else {
            held.push(deliver)
          }
        },
      }
      channels.push({ name, channel })
      return channel
    },
  }
}

/** A `localStorage` stand-in shared by every client ("tab") it is given to. */
export interface FakeLinkStorage extends LinkStorageLike {
  /** Everything stored, by key. */
  entries: Map<string, string>
  /** Make every access throw, as a browser that refuses storage does. */
  failing: boolean
}

/** @returns An empty shared storage. */
export function fakeLinkStorage(): FakeLinkStorage {
  const entries = new Map<string, string>()
  const guard = (storage: FakeLinkStorage) => {
    if (storage.failing) {
      throw new DOMException('storage is not available', 'SecurityError')
    }
  }
  const storage: FakeLinkStorage = {
    entries,
    failing: false,
    get length() {
      guard(storage)
      return entries.size
    },
    key(index) {
      guard(storage)
      return [...entries.keys()][index] ?? null
    },
    getItem(key) {
      guard(storage)
      return entries.get(key) ?? null
    },
    setItem(key, value) {
      guard(storage)
      entries.set(key, value)
    },
    removeItem(key) {
      guard(storage)
      entries.delete(key)
    },
  }
  return storage
}

/** A page address a test can read back after the client rewrote it. */
export interface FakePage extends PageLike {
  /** The current address. */
  current: string
  /** Every address `replaceUrl` was given. */
  replaced: string[]
  /** Every URL the page was sent to (`assign`), oldest first. */
  assigned: string[]
}

/**
 * @param url - The address the "tab" was opened at.
 * @returns The page.
 */
export function fakePage(url: string): FakePage {
  const page: FakePage = {
    current: url,
    replaced: [],
    assigned: [],
    assign(next) {
      page.assigned.push(next)
    },
    url: () => page.current,
    replaceUrl(next) {
      page.replaced.push(next)
      page.current = next
    },
  }
  return page
}

/** Timers a test fires by hand. */
export interface FakeTimers {
  setTimer(callback: () => void, ms: number): () => void
  /** The delays of the timers that are set and not yet fired or cancelled. */
  pending(): number[]
  /** Fire the oldest pending timer. Returns `false` when there is none. */
  fire(): boolean
  /** How many timers were cancelled before they fired. */
  cancelled: number
}

/** @returns Timers that only run when the test says so. */
export function fakeTimers(): FakeTimers {
  let queue: { callback: () => void; ms: number }[] = []
  const timers: FakeTimers = {
    cancelled: 0,
    setTimer(callback, ms) {
      const entry = { callback, ms }
      queue.push(entry)
      return () => {
        if (queue.includes(entry)) {
          queue = queue.filter((other) => other !== entry)
          timers.cancelled += 1
        }
      }
    },
    pending: () => queue.map((entry) => entry.ms),
    fire() {
      const next = queue.shift()
      next?.callback()
      return next !== undefined
    },
  }
  return timers
}

/**
 * @param clock - The clock.
 * @param parts - Locks, a channel hub, shared storage, a page and timers, when the test's
 *   "browser" has them. Without `timers`, real ones are used.
 * @returns The environment for one client.
 */
export function fakeEnvironment(
  clock: ManualClock,
  parts: {
    locks?: LockManagerLike
    hub?: FakeChannelHub
    linkStorage?: LinkStorageLike
    tabStorage?: LinkStorageLike
    page?: PageLike
    timers?: FakeTimers
    passkeys?: PasskeyGlobals
    passkeyProvider?: PasskeyProvider
  } = {}
): Environment {
  const hub = parts.hub
  return {
    now: () => clock.now(),
    locks: parts.locks,
    createChannel: hub ? (name) => hub.createChannel(name) : undefined,
    linkStorage: parts.linkStorage,
    tabStorage: parts.tabStorage,
    page: parts.page,
    passkeys: parts.passkeys,
    ...(parts.passkeyProvider && { passkeyProvider: parts.passkeyProvider }),
    setTimer:
      parts.timers?.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      }),
  }
}
