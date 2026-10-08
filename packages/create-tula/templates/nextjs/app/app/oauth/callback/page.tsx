import { OAuthCallback } from '@tula/nextjs'

/**
 * Where "Continue with …" and "Connect …" come back to (`oauthCallbackUrl` in the layout).
 * The provider returns the visitor to the API's own host, which sends them here with a
 * one-time ticket in the URL fragment; the component exchanges it through the route handler,
 * so the session's cookies are this app's. The visitor is not signed in yet when they arrive,
 * so the proxy leaves this route public.
 *
 * In a deployed app this exact URL is listed in the environment's `urls.allowedRedirectUrls`;
 * a local API allows any loopback URL.
 */
export default function OAuthCallbackPage() {
  return <OAuthCallback userProfileUrl='/profile' />
}
