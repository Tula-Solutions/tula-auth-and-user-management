import type {
  OAuthAuthorizationRequest,
  OAuthCodeExchange,
  OAuthCredentials,
  OAuthProfile,
  OAuthProvider,
  OAuthProviderError,
  OAuthProviders,
} from '~/ports/oauth-provider'

/**
 * A scriptable provider for unit tests: no network, no keys.
 *
 * A test decides what the "provider" answers by setting {@link FakeOAuthProvider.profile} (or
 * {@link FakeOAuthProvider.failure}) before it calls the callback, and reads back what the
 * server sent to the provider from {@link FakeOAuthProvider.requests} and
 * {@link FakeOAuthProvider.exchanges}.
 */
export class FakeOAuthProvider implements OAuthProvider {
  /** What the next exchange answers. */
  profile: OAuthProfile
  /** When set, the next exchange throws it instead. */
  failure: OAuthProviderError | Error | null
  /** Every authorization request built, oldest first. */
  readonly requests: OAuthAuthorizationRequest[]
  /** Every exchange asked for, with the credentials it was asked with, oldest first. */
  readonly exchanges: (OAuthCodeExchange & { credentials: OAuthCredentials })[]

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(readonly name: string) {
    this.profile = {
      subject: `${name}-subject-1`,
      email: 'maya@northline.app',
      emailVerified: true,
    }
    this.failure = null
    this.requests = []
    this.exchanges = []
  }

  authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
    this.requests.push({ ...request })
    const url = new URL(`https://${this.name}.provider.test/authorize`)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('state', request.state)
    url.searchParams.set('redirect_uri', request.redirectUri)
    return url.toString()
  }

  async exchange(
    credentials: OAuthCredentials,
    exchange: OAuthCodeExchange
  ): Promise<OAuthProfile> {
    this.exchanges.push({ ...exchange, credentials: { ...credentials } })
    if (this.failure) {
      throw this.failure
    }
    return { ...this.profile }
  }
}

/** The fake adapter of every provider, typed so a test can script each one. */
export type FakeOAuthProviders = OAuthProviders & Record<keyof OAuthProviders, FakeOAuthProvider>

/**
 * @returns A fresh fake for every provider.
 */
export function fakeOAuthProviders(): FakeOAuthProviders {
  return {
    google: new FakeOAuthProvider('google'),
    github: new FakeOAuthProvider('github'),
    apple: new FakeOAuthProvider('apple'),
    microsoft: new FakeOAuthProvider('microsoft'),
  }
}
