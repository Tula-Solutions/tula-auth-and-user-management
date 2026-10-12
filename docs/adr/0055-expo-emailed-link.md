# ADR 0055 — An emailed sign-in link opened in an Expo app

- Status: accepted
- Date: 2026-10-12

## Context

An emailed sign-in link ([ADR 0024](0024-email-sign-in.md)) is honoured only in the client
that asked for it: the server hands the asking client a **link binding** once, stores its
SHA-256 on the attempt, and accepts the link's token only together with it. Accepting a
link creates no session; the holder of the attempt's secret completes.

[ADR 0048](0048-expo-passkeys-and-providers.md) left the link out of `@tula/expo`: the
environment had no `linkStorage`, so asking for a link failed with `storage.failed` before
any request, and a step that offered only a link was the screen `not_supported`. It named
what a decision would have to say (where the binding is kept and for how long, which deep
link is read, what the server refuses), and [ADR 0052](0052-expo-native-providers-and-device-keys.md)
left it there. This record decides it (TULA-73).

What exists and is not changed:

- **`@tula/core`** asks for the link (`prepareFirstFactor({ strategy: 'email_link',
  redirectUrl })`), keeps the binding through `Environment.linkStorage` under
  `tula.link.<attempt id>` for fifteen minutes, reads a link from its page's address,
  takes it out of the address before anything is sent, presents it with the binding
  (`POST /v1/client/sign-ins/link`), and removes the binding when the link is accepted,
  when the sign-in completes and when the flow is discarded. The attempt's secret is in
  the flow object's closure and nowhere else, and the client has no call that resumes an
  attempt it did not start.
- **The server** matches the link's redirect URL exactly against
  `urls.allowedRedirectUrls`, refuses a custom scheme for an emailed link
  (`request.redirect_not_allowed`, `not_a_provider_sign_in`:
  [ADR 0044](0044-app-link-and-custom-scheme-redirects.md)), puts the token in the URL's
  fragment, and answers a link presented without its binding with
  `verification.different_browser`, spending nothing.
- **App links** ([ADR 0040](0040-native-app-identity.md), ADR 0044): an environment's
  native app has exact `appLinkPaths`, served in the two association files; the config
  plugin's `appLinks` writes the app's side.

**Nothing in this record was run on a device, a simulator or in Expo Go.** No emailed link
ever opened an app through this package, and no association file was fetched by Apple or
Android for it. The journey hands the package the URL as an operating system would. What
that leaves unverified is in
[the Phase 2 list](../plans/phase-2-unverified.md#step-213-an-emailed-link-opened-in-tulaexpo-tula-73-adr-0055).

## Decisions

### No change to the server, and none to `@tula/core`

Everything the server needs it already does: an `https` app link is an ordinary entry of
the redirect list, and the binding rule is the browser's own. `@tula/core`'s bundle has
four bytes of its budget left; the package uses the calls the client already has
(`prepareFirstFactor`, `signIn.handleEmailLink`, `attemptFirstFactor`) through the
environment `@tula/expo` builds for it.

### The link opens the app directly; there is no page in between, and no custom scheme

The link in the email is the app link itself (`https://<domain>/<path>#tula_link=…`). The
operating system opens the app for it where the domain is associated with the app.

- **A web page that hands over to the app** (the page reads the link, then opens the app
  through a custom scheme or a second link) was not built. The page is a browser that
  asked for nothing: it holds no binding, so it could present nothing itself, and passing
  the token on puts it in a second URL, in a browser's history and in whatever that page
  loads. A hand-over by custom scheme is also what any other app on the phone can claim.
- **A custom scheme as the link's URL** stays refused by the server
  (`not_a_provider_sign_in`), and `emailLinkUrl` refuses one when the client is created.
  Nothing binds a custom scheme to one app; a provider sign-in may return through one
  only because PKCE and the ticket's binding bound the damage, and an emailed link has
  neither PKCE nor a browser session that returns the URL to its caller.

### The app says once which URL is its emailed-link URL

`createTulaExpoClient({ emailLinkUrl })`: one `https` URL with no fragment and no white
space, judged when the client is created (a fixed `TypeError` that repeats nothing).
Every link the client asks for leads there; the hooks take no redirect URL for a link.

- Without the option nothing changes from ADR 0048: asking is `storage.failed` before any
  request, and a step that offers only a link is `not_supported`
  (`waysOf(client).emailLink`).
- A redirect URL per call was the alternative. It is what `@tula/core` has, for pages; an
  app has one link the operating system gives it, and a URL chosen per call could be one
  the app is never opened with, or one the package would then have to remember per
  attempt in order to judge what comes back.
- The package does not judge whether the environment lists the URL: the server's
  `request.redirect_not_allowed` is thrown as it is, and no email is sent.

### Which URL is read: the app link, character for character, with a link in its fragment

A URL an app is opened with is untrusted input: any app, page or message can open one. A
platform hands an app whatever URL matched its association, by host and by path prefix
(and Android's file cannot name a path at all: one path there is every link of the
domain). So `openEmailLink` reads a URL only when **all** of this holds, and otherwise
makes **no request**:

1. it is `emailLinkUrl`, character for character, followed by `#`. Nothing is normalised
   on either side: another case, a longer path, a trailing slash, a query, another host,
   user info and a percent-encoded spelling are other URLs (`unexpected_url`);
2. its fragment carries both a token and an attempt id (`no_link`);
3. the attempt is the one of the sign-in it was handed with, and
4. the client still keeps the binding the server gave it for that attempt
   (`not_started_here` for 3 and 4).

This is stricter than a browser, which presents any link it finds in its address and lets
the server refuse. The server would refuse the same cases and spend nothing; the package
does not ask, because a request made for every URL an app can be opened with is a request
anybody can cause. `isEmailLink(client, url)` answers rules 1 and 2 alone, so that an app
with other links can tell them apart without a request.

The token leaves the URL before anything is sent (the client's own handling), travels in
one JSON body to one route, and is never written to the secure store, a log line, an
error or a URL the package builds. A test's canaries hold that for the token, the binding
and the attempt's secret.

### The binding is kept in memory, for fifteen minutes, and not in the secure store

The environment's `linkStorage` is a `Map` in the client's closure (`memoryLinks`). An
entry is dropped fifteen minutes after it was written, by the device's clock in either
direction (a clock set back does not keep one alive), and by `@tula/core` when the link is
accepted, when the sign-in completes another way and when the flow is discarded. It ends
with the process.

**The secure store was the other choice, and the ticket's own first thought** (ADR 0048:
"the binding on the device across the app being ended"). It was not taken, for what a
binding is worth alone:

- Accepting a link signs nobody in. Only the holder of the attempt's secret completes,
  and that secret lives in the flow object, in memory. An app that was ended has lost it.
  A binding that outlived the app would let the restarted app **spend** the link, with
  nobody left who can finish: worse for the user than a refusal, since the link still
  works in an app that kept running and is dead after being spent.
- Keeping the attempt as well would mean writing the attempt's secret to storage and
  adding a call to `@tula/core` that resumes an attempt from a stored secret. The secret
  is a credential of the sign-in under way (every later step is authorized by it, and
  after the link is accepted it alone completes), it is stored nowhere today, in any
  client, and the call would be new public surface of a client whose bundle budget has
  four bytes of room (the call was not written, so its size was not measured). That is a
  decision of its own, with its own threat model (what a restored backup, a second
  process or a debugger reads), not a detail of this one.
- Memory is where the provider round trip's binding already is (ADR 0048), for the same
  reason.

**So what a user sees when the app was ended in between**: the phone ended the app while
the mail app was in front, the link starts the app again, and `openEmailLink` answers
`not_started_here` (the hook's error `verification.different_browser`) without a request.
Nothing was spent, and nothing can be finished: the code of that email belongs to the
same lost sign-in. The user asks again, in the app as it runs now. The docs and the
example say so, and say to offer the code field beside "check your email", which is the
path that survives the email being read on another device. How often a phone ends an app
in the seconds it takes to open an email was not measured.

### Accepting the link and finishing are two steps, and the sign-in that asked finishes

`openEmailLink(client, flow, url)`:

1. judges the URL (above);
2. gives the client's page that address and calls `signIn.handleEmailLink({ waitMs: 0 })`:
   the client presents the token with the binding, once. The address is cleared in a
   `finally`. A link the server calls used, replaced or too old is `expired`; one it says
   another client asked for is `not_started_here`;
3. asks the flow once to finish (`attemptFirstFactor({ strategy: 'email_link' })`). The
   step is `complete`, or what the server asks for next: a second factor still comes
   after a link, as after every first factor.

There is no polling and no waiting for a session to appear: the flow that holds the
attempt's secret is in the same process, so it is asked directly. `waitMs: 0` still
passes through one zero-length timer of the client's runtime inside `@tula/core`; it is
not one of the package's `Schedule` waits and nothing is timed by it.

What the server or the network answered to the link itself (no answer, `rate_limited`,
`auth.method_disabled`) is thrown, with nothing spent: the same URL can be opened again.
A link that was taken while step 3 got no answer is `accepted` with `failure` and the
step unchanged; the hook's `finishEmailLink()` asks again. The link is spent by then,
which is the server's order and is not changed.

One link at a time, and never beside a provider's round trip: the client has one page
address, and both take it (`flow.busy`).

### What a link opened anywhere else does

| Opened in | What happens | Spent |
| --- | --- | --- |
| The app and the sign-in that asked | Accepted, then that sign-in finishes. | The link. |
| The same app on another phone, or after a restart | `not_started_here`, no request. | Nothing. |
| The same app, another sign-in | `not_started_here`, no request. | Nothing. |
| Another app that claims the URL, or a client that sends it without the binding | The server's `verification.different_browser`. | Nothing. |
| A browser (a desktop mail client, a mail app's own browser, a phone without the app) | Whatever the operator's domain serves there. A page that presented the link would be answered `verification.different_browser`. | Nothing. |

A crafted link sent to a victim (an attacker starts a sign-in for their own account and
mails the link, hoping the victim's app ends up signed in as the attacker) reaches rule 4:
the victim's client holds no binding for the attacker's attempt, and makes no request.

**A mail app's own browser.** Some mail apps open a link in a web view of their own
instead of handing it to the operating system; the app is then never opened. Nothing in
this package can change that, and nothing is spent by it. The operator's page at that
address should say to open the email on the phone that asked, or to type the code; the
docs say so. Which mail apps do it, and whether a universal link is followed from each,
was not looked at. Mail scanners that fetch links see an `https` URL whose token is in
the fragment, which is not sent to a server, and could present nothing without the
binding.

### The hooks

`useSignIn()` gains `prepareFirstFactor({ strategy: 'email_link' })`, `openEmailLink(url)`
and `finishEmailLink()`. `openEmailLink` resolves `null` and changes nothing for a URL
that is not the client's emailed-link URL with a link in it, so every URL the app is
opened with can be handed over. A link that is not this sign-in's is the hook's error
`verification.different_browser`, and a dead one `verification.expired`: the contract's
codes for the same two answers, set without a request for the first. `@tula/core`'s
sentences for them speak of a browser and of a code, so the docs say to word them by
code. No error code was added.

The package gains no native module: the app passes the URL it gets from React Native's
`Linking`, which every Expo app has. The package stays headless.

### The journeys

"email link sign-in" becomes a `journey` for `expo`: refused on another phone without a
request, refused by the server without the binding, accepted in the app that asked, which
is the one signed in; the token and the binding travel in one request body and nowhere
else. Beside it the suite holds an app that was ended and started again, an app link the
environment does not list, and a client without the option. `expo` has no `not_built`
entry left; the count per ticket is empty, in the suite and in
`packages/conformance/src/client-journeys.test.ts`.

## Not decided here

- **A sign-in that survives the app being ended**: the attempt's secret and the binding
  at rest, and a call of `@tula/core` that resumes an attempt. See above for why it is a
  decision and not an addition. It would also serve a provider's round trip and a second
  factor typed after a restart.
- **A link asked for on one device and opened on another.** ADR 0024 rules it out, on
  purpose. The code is that path.
- **A page for the link's address** (what a browser shows there). It is the operator's.
  A template for it could come with the app scaffold.
- **Sign-up and password reset by link.** The server has no such link.
- **Reading the launch URL in the package.** The app hands URLs over; a module of the
  package that listens by itself would be a seventh native import.
