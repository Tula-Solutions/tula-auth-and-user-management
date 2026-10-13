---
paths:
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/verification/**"
  - "apps/api/src/modules/settings/**"
  - "packages/contract/src/redirect-url*"
---

# Flows: attempt binding, emailed codes and links, redirect URLs

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Security rules (non-negotiable)

- **Every flow call after the start presents the attempt's secret** (`x-tula-attempt`). The
  secret is 256 bits, returned once by the start, stored only as SHA-256 and never logged or
  audited. Missing, wrong or another attempt's: the same `flow.not_found` as an unknown attempt,
  before anything is counted, spent or sent. An attempt with no stored hash matches no secret.
- **A browser flow is bound to an allowed origin.** An attempt started as a `web` client is
  refused (`request.origin_not_allowed`) at its start and at every step unless the request has
  no `Origin` or one the environment allows, before any state changes. This is what stops a
  foreign page from having a session cookie set (login CSRF).
- **The first factors a sign-in offers depend only on the environment's settings**, never on
  the identifier: the start does not look the identifier up.
- **Asking for a sign-in email answers the same for every address.** An address with no account
  is sent a notice with no code and no link, its attempt holds a decoy, and the response, the
  send limits and the cost are the same. An emailed code counts against the same per-identifier
  lockout as the password, and a token issued for one purpose (`email_verification`,
  `password_reset`, `sign_in`) is never honoured for another.
- **An address proven for the first time by someone who did not prove the password loses the
  password.** An unverified account with a password was made by someone other than the
  address's proven owner (an admin create); when an emailed code or link (or the code after a
  passkey sign-in) verifies the address, the password is removed in the same store transaction
  (`markEmailVerified` with `removePassword`), recorded (`user.password_changed`,
  `removed: true`) and announced, and the owner sets one by reset. Never verify an address
  for a verifier who has not proven the password by any other call; after a password sign-in,
  in a sign-up and in a reset the password stays (ADR 0024).
- **An emailed link is honoured only in the browser that asked for it.** The link's token is
  accepted only together with the `linkBinding` returned once to the asking client (stored as
  SHA-256 on the attempt, compared in constant time). Without it the answer is
  `verification.different_browser` and nothing is spent: a victim clicking a link an attacker
  asked for proves nothing. Accepting a link never creates a session; only the holder of the
  attempt's secret completes. The token travels in the URL **fragment**, never a query, and in
  a JSON body to the API. Never weaken either rule to make links work across devices: the code
  in the same email is the cross-device path.
- **A redirect URL is matched exactly** against `urls.allowedRedirectUrls`
  (`Settings.requireRedirectUrl`): no prefix, pattern or same-host rule. Loopback `http` URLs
  are allowed in the `local` tier only. That one function decides for every kind of URL
  and every caller tells it what the URL is for (`RedirectUse`: the attempt's client kind
  and, for a provider sign-in, the provider); never judge a redirect URL anywhere else.
  **What an entry may be is the contract's `redirectUrlKind`** (`@tula/contract/redirect-url`,
  Zod-free): `https://…`, loopback `http://…`, or a custom scheme with a full stop that is
  not on `REDIRECT_SCHEMES_NEVER_CUSTOM` nor in a family of
  `REDIRECT_SCHEME_FAMILIES_NEVER_CUSTOM`, with a path of plain segments and no query,
  fragment, percent-encoding or user name. Nothing is normalised when an entry is saved or
  compared (a web entry must start with `https://` or `http://` as written). Never loosen
  the grammar to a scheme without a full stop, and never take a scheme off the deny-list.
  **The deny-list is best effort and nothing rests on it** (a dotted scheme a platform
  handles that nobody listed passes): what bounds a custom scheme is that the operator
  lists each entry by hand and that a redirect carries only a bound ticket. The same holds
  for `client_not_native`: the client kind is the client's own claim (`x-tula-client`), a
  policy check for honest clients and not a boundary. **No redirect URL of any kind holds
  whitespace, a wildcard, a control character, a backslash, a character that draws nothing
  (`hasInvisibleCharacter`: `Cf`, the variation selectors, `Default_Ignorable_Code_Point`;
  the contract's one definition, never a second list) or what `hasHiddenCharacter`
  refuses** (`hasForbiddenRedirectCharacter`, asked at save, by the tolerant read and by
  `requireRedirectUrl` for every URL it honours; an entry is compared as the string it is,
  so it holds only what can be seen, and a stored entry that no longer passes is dropped by
  the read and stops matching: never loosen the class to the joiners an email's wording
  keeps), and the provider callback answers the
  static page, never a 500, if a redirect cannot be built: the state is spent by then.
  **Listing a custom scheme is a weakening** (`settingsWeakenings`:
  `urls.allowedRedirectUrls`, the list's name and never the URL).
- **No session before the second factor.** After a first factor, and after a password reset,
  the engine asks `Factors.requiredFor`; a non-empty answer means `needs_second_factor` and no
  tokens. Never call `Sessions.create` for a sign-in outside the flow service's `finish`.
