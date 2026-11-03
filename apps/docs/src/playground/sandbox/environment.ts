import type { ChannelLike, Environment, LinkStorageLike, PasskeyProvider } from '@tula-tech/core'

// What the client takes from the runtime, replaced by the sandbox's own: a page that is a
// value in memory (so a provider round trip happens inside the playground's frame and not in
// the browser's address bar), storage that is a Map (so no token, binding or attempt secret
// reaches `localStorage` or `sessionStorage`) and a simulated authenticator in place of
// `navigator.credentials`. The playground never calls the browser's WebAuthn.

/** A storage that lives in memory only, with the shape of `localStorage`. */
export function memoryLinkStorage(): LinkStorageLike {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    get length() {
      return entries.size
    },
    key: (index) => [...entries.keys()][index] ?? null,
  }
}

/** Channels between the client's parts of one page, standing in for `BroadcastChannel`. */
function channelBus(): (name: string) => ChannelLike {
  const open = new Map<string, Set<ChannelLike>>()
  return (name) => {
    const group = open.get(name) ?? new Set<ChannelLike>()
    open.set(name, group)
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(message) {
        for (const other of group) {
          if (other !== channel) {
            other.onmessage?.({ data: message })
          }
        }
      },
      close() {
        group.delete(channel)
      },
    }
    group.add(channel)
    return channel
  }
}

/** The page the client believes it is on. */
export interface VirtualPage {
  /** The address, fragment included. */
  url(): string
  /** Go to an address inside the playground (an emailed link, a provider's return). */
  set(url: string): void
}

/** What a passkey sheet is asked. */
export interface PasskeySheetRequest {
  kind: 'create' | 'get'
  /** The relying party's name, as a sheet would show it. */
  rpName: string
  /** The account the passkey is for (`create`). */
  account?: string
}

/** Options of {@link createSandboxEnvironment}. */
export interface SandboxEnvironmentOptions {
  /** The clock. */
  now: () => number
  /** The page's address to start from. Its origin is the one redirect URLs must be on. */
  pageUrl: string
  /** Called when the client sends the page somewhere (`location.assign`): a provider's URL. */
  onNavigate: (url: string) => void
  /**
   * Asked before the simulated authenticator answers: the playground draws a sheet that says it
   * is simulated. Resolve `true` to approve, `false` to cancel.
   */
  confirmPasskey: (request: PasskeySheetRequest) => Promise<boolean>
}

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function cancelled(): Error {
  // What a browser rejects with when the user dismisses the sheet; the client reads `name`.
  return Object.assign(new Error('The sandbox passkey sheet was dismissed.'), {
    name: 'NotAllowedError',
  })
}

/** The simulated authenticator: the credentials "this device" holds. */
export interface SandboxAuthenticator {
  /** Credential ids, newest last. */
  credentials: string[]
  /** Forget them all (the playground's reset). */
  clear(): void
}

/**
 * Make the sandbox's environment.
 *
 * @param options - The clock, the starting page, and what navigation and the passkey sheet do.
 * @returns The environment for `createTulaClientWithEnvironment`, the virtual page, and the
 *   simulated authenticator.
 */
export function createSandboxEnvironment(options: SandboxEnvironmentOptions): {
  environment: Environment
  page: VirtualPage
  authenticator: SandboxAuthenticator
} {
  let current = options.pageUrl
  const authenticator: SandboxAuthenticator = {
    credentials: [],
    clear() {
      authenticator.credentials.length = 0
    },
  }
  const provider: PasskeyProvider = {
    autofillAvailable: () => false,
    async create(creation) {
      const approved = await options.confirmPasskey({
        kind: 'create',
        rpName: creation.rp.name,
        account: creation.user.name,
      })
      if (!approved) {
        throw cancelled()
      }
      const id = base64Url(
        `sbx-credential-${authenticator.credentials.length + 1}-${options.now()}`
      )
      authenticator.credentials.push(id)
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64Url(
            JSON.stringify({
              type: 'webauthn.create',
              challenge: creation.challenge,
              sandbox: true,
            })
          ),
          attestationObject: base64Url('sandbox-attestation'),
          transports: ['internal'],
        },
      }
    },
    async get(request) {
      const approved = await options.confirmPasskey({ kind: 'get', rpName: request.rpId })
      if (!approved) {
        throw cancelled()
      }
      const allowed = request.allowCredentials?.map((credential) => credential.id)
      const id = allowed?.length
        ? allowed.find((one) => authenticator.credentials.includes(one))
        : authenticator.credentials.at(-1)
      if (id === undefined) {
        // No passkey for this site on "this device": the sheet has nothing to offer.
        throw cancelled()
      }
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64Url(
            JSON.stringify({ type: 'webauthn.get', challenge: request.challenge, sandbox: true })
          ),
          authenticatorData: base64Url('sandbox-authenticator-data'),
          signature: base64Url('sandbox-signature'),
          userHandle: null,
        },
      }
    },
  }
  const environment: Environment = {
    now: options.now,
    locks: undefined,
    createChannel: channelBus(),
    linkStorage: memoryLinkStorage(),
    tabStorage: memoryLinkStorage(),
    passkeys: undefined,
    passkeyProvider: provider,
    page: {
      url: () => current,
      replaceUrl: (url) => {
        current = url
      },
      assign: (url) => options.onNavigate(url),
    },
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
  }
  return {
    environment,
    page: {
      url: () => current,
      set(url) {
        current = url
      },
    },
    authenticator,
  }
}
