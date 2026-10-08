/**
 * Where the components send the user. Every URL is one the developer passed as a prop; the
 * components never read a destination from the query string, the fragment or the server, which
 * is what keeps them from being an open redirect.
 *
 * @example
 * ```tsx
 * <TulaProvider publishableKey={key} baseUrl={url} signInUrl='/sign-in' afterSignInUrl='/app'>
 *   …
 * </TulaProvider>
 * ```
 */
export interface NavigationOptions {
  /**
   * How to go to a URL. Defaults to `window.location.assign`. Pass your router's function for
   * client-side navigation, e.g. `(url) => router.push(url)`.
   */
  navigate?: (url: string) => void
  /** Where `<SignIn>` lives: the target of "Already have an account? Sign in". */
  signInUrl?: string
  /** Where `<SignUp>` lives: the target of "New here? Create an account". */
  signUpUrl?: string
  /** Where to go once a sign-in (or a password reset) completes. */
  afterSignInUrl?: string
  /**
   * The page emailed sign-in links lead to: the one that renders `<EmailLinkCallback>`. It must
   * be one of the environment's allowed redirect URLs, exactly (a relative value is resolved
   * against the page first). Without it `<SignIn>` does not offer "Email me a link".
   */
  emailLinkUrl?: string
  /**
   * The page an OAuth sign-in returns to: the one that renders `<OAuthCallback>`. It must be
   * one of the environment's allowed redirect URLs, exactly (a relative value is resolved
   * against the page first), and on this origin. Without it no "Continue with …" button is
   * drawn.
   */
  oauthCallbackUrl?: string
  /** Where to go once a sign-up completes. */
  afterSignUpUrl?: string
  /**
   * Where to go after signing out from `<UserButton>` or `<UserProfile>`: only once the server
   * was told. A sign-out that did not reach it navigates nowhere and is said in a dialog.
   */
  afterSignOutUrl?: string
  /** Where `<UserProfile>` lives. Without it `<UserButton>` opens the profile in a dialog. */
  userProfileUrl?: string
}

/** Whether a value names its own scheme (`https://…`), as opposed to being relative to the page. */
function isAbsolute(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Check a URL a developer passed before navigating to it: a relative URL (resolved against the
 * page) or an absolute `http(s)` one. Anything else (`javascript:`, `data:`, a malformed
 * value) is refused, so a prop that was built from untrusted input cannot run script.
 *
 * A relative destination means this origin. A value with no scheme that still names a host
 * (`//host`, `/\host`, or a path such as `/.//host` that normalises to one) is refused: another
 * site has to be written out with its scheme, which a value copied from the address bar by
 * mistake does not survive.
 *
 * @param url - The URL as passed.
 * @param base - What a relative URL is resolved against; the page's address in a browser.
 * @returns The absolute URL, or `null` when it is refused.
 *
 * @example
 * ```ts
 * safeUrl('/app', 'https://example.com/sign-in') // 'https://example.com/app'
 * safeUrl('javascript:alert(1)', 'https://example.com/') // null
 * safeUrl('//other.example', 'https://example.com/') // null
 * ```
 */
export function safeUrl(url: string | undefined, base: string): string | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return null
  }
  try {
    const resolved = new URL(url, base)
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
      return null
    }
    if (!isAbsolute(url)) {
      // A router is handed the string as written and resolves it again: a path that starts
      // with two slashes after normalisation is a host to it.
      if (resolved.origin !== new URL(base).origin || resolved.pathname.startsWith('//')) {
        return null
      }
    }
    return resolved.href
  } catch {
    return null
  }
}

/**
 * Go to a developer-supplied URL, through the app's own `navigate` when it gave one.
 *
 * @param url - The destination; nothing happens when it is missing or refused by {@link safeUrl}.
 * @param navigate - The app's navigation function.
 * @returns Whether a navigation was started.
 */
export function go(
  url: string | undefined,
  navigate: ((url: string) => void) | undefined
): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const resolved = safeUrl(url, window.location.href)
  if (resolved === null || url === undefined) {
    return false
  }
  if (navigate) {
    // The router gets what the developer wrote (routers want paths, not absolute URLs).
    navigate(url)
  } else {
    window.location.assign(resolved)
  }
  return true
}
