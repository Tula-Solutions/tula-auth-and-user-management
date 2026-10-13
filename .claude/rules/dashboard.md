---
paths:
  - "apps/dashboard/**"
  - "e2e/tests/dashboard/**"
---

# Dashboard app

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Dashboard app (`apps/dashboard`, see ADR 0032)

- **Every API call goes through an Orval-generated hook and `dashboardFetch`**
  (`src/api/mutator.ts`): `x-tula-dashboard: 1`, the cookie, never `Authorization`, the
  selected environment on admin calls, and one error type (`ApiError`). A 401
  `auth.unauthenticated` ends the session; the shell returns to sign-in and back to the same
  address. Only `/v1/admin/*` and `/v1/instance/*` get hooks.
- **The address is the selection** (`/w/<id>/p/<id>/e/<id>/…`, filters and pages as search
  parameters); the Zustand scope store mirrors it through `syncScope` in each route's
  `beforeLoad`, which also drops cached admin answers when the environment changes (admin
  queries are keyed by path, the environment travels in a header).
- **A switch remounts.** The router keeps a route's component when only a path parameter
  changes, so everything under the environment route is keyed by the environment id
  (`EnvironmentGate`), the workspace screen by the workspace id, the user screen by the user
  id, and a list item that holds form state includes the environment id in its key
  (`ProviderCard`). The settings editor's document and draft belong to the environment they
  were loaded for and a save is refused for any other. The shell is never remounted: a dialog
  it owns is bound to the workspace or project it was opened in. A new screen with a draft,
  a typed secret or a confirmation dialog gets a test in `src/environment-switch.test.tsx`.
- **A failed sign-out is not a sign-out.** The app leaves for the sign-in page only once the
  API has cleared the cookie; otherwise it stays and says the session is still active.
- **It runs under the API's strict Content-Security-Policy, and the browser tests fail on any
  violation.** No inline script or style, no `eval`, no library that injects a `<style>`:
  dialogs are the platform's `<dialog>` (`components/modal.tsx`; Radix's dialog and select
  inject styles), toasts are the app's own live region, selects are shadcn's `native-select`,
  and Zod runs in its interpreter (`src/lib/zod-csp.ts`, imported first by `main.tsx`: Zod
  otherwise probes `new Function`). Never loosen `DASHBOARD_CSP` for a library.
- **A route file's `validateSearch` and `beforeLoad`, and anything they import at module
  level, must not reach `zod` or `@tula/contract`'s schema modules** (the Zod-free entry
  points are fine). They are in the entry chunk and run before `src/lib/zod-csp.ts` switches
  Zod to its interpreter, so the page then violates the policy; a screen may import schemas,
  because the router splits a route's `component` into a chunk loaded after the switch.
  Nothing in happy-dom notices: the test "what a route file runs before its screen is loaded
  stays free of Zod" (`src/features/webhooks/words.test.ts`, with
  `src/testing/entry-imports.ts`) walks the imports, and the browser tests fail on the
  violation. A new route file with a `validateSearch` or a `beforeLoad` that imports
  anything is added to that test's list.
- **A dialog whose answer carries a secret cannot be dismissed while its request is in
  flight.** The server has made the endpoint or rotated the secret by then, and a dialog
  that let go would drop the only answer that holds it. `Modal`'s `busy` refuses Escape and
  undoes a forced close, `SecretRequestActions` keeps Cancel focusable but unavailable and
  says why, and the list is refreshed by the mutation hook's own `onSuccess`, never the one
  passed to `mutate()`. That refresh is **started and not awaited** (the callback returns
  nothing): the query client waits for a hook-level `onSuccess` before the mutation counts
  as done, so an awaited refresh keeps the secret off the screen, and the dialog shut, for
  as long as the list takes to come back. A navigation or an environment switch still loses the secret:
  accepted, and nothing of it is shown under another environment.
  `src/secret-dialogs.test.tsx` holds each.
- **An address from the server is shown so that it can be checked.** A webhook endpoint's
  address goes through `printable()` (`src/lib/printable.ts`: what a reader cannot see is
  written as an escape) inside `<bdi dir="ltr">` (`features/webhooks/address.tsx`), in
  cards, headings, dialog titles and the text to type for a confirmation; what is typed is
  compared with what is displayed. Combining marks are written out too, and the address
  field of the add and edit forms says so under the input when what it holds differs from
  what can be seen.
- **A confirmed change is sent once.** A confirmation's button stays unavailable from the
  click until its dialog closes (a refused request gives it back), because the mutation is
  no longer pending while the list is read again and a second click would send the request
  a second time. `src/webhooks.test.tsx` ("a confirmed change is sent once") holds it for
  the webhook dialogs; the API key revocation predates the rule and does not follow it yet.
- **No secret outlives its form.** The admin token, a created API key, a typed password and a
  provider secret are component state only while their form or dialog is open: never
  `localStorage`, `sessionStorage`, the address or a log. A mutation that carries one uses
  `gcTime: 0` and is `reset()` when the form lets go (the query client keeps a mutation's
  variables), and the router's scroll restoration stays off (it writes to `sessionStorage`).
  `src/app.test.tsx` and the browser tests walk the app and assert storage, the address, the
  document and the query caches are clean.
- **One save model for settings** (`features/settings/settings-editor.tsx`): load with the
  revision, replace with `If-Match`, 412 is "changed elsewhere" with a reload and never a
  retry, a weaker policy (`settingsWeakenings`) or managed settings ask first. A settings
  screen is a `SettingsFrame`.
- **Destructive actions name what they act on** and, in a production environment, ask for it
  to be typed (`ConfirmDialog`'s `requireText`). Server text is rendered as text; a link is
  an app route or a validated `https:` URL.
- **The Messages screen** (`features/messages`, [ADR 0042](../../docs/adr/0042-message-wording-editor.md))
  is a `SettingsFrame` over `emails.templates` and `sms.templates`: no save path of its
  own. **The preview is the server's answer, drawn as text nodes** (`<p>` and `<pre>`):
  never `dangerouslySetInnerHTML`, an `iframe`, `srcdoc` or a renderer in the browser.
  **Why a wording would be refused is the contract's validator** (`problemsOf`), never a
  rule of the screen's; a draft with a problem is not sent to the preview. The kinds come
  from the contract's two lists (a kind without a label does not compile), the placeholder
  buttons from its rules. An empty part is a key left out, so that an untouched draft is
  byte for byte what was loaded. A preview's answer is shown only for the message and the
  environment it was asked for. Wording is prose: what cannot be seen in it is named with
  `unseenCodePoints` (`src/lib/printable.ts`), not written out with `printable()`, which
  escapes every space. The chosen message is state, not a search parameter (a
  `validateSearch` would run before Zod's switch).
- **The Text messages screen** (`features/sms`, [ADR 0037](../../docs/adr/0037-phone-numbers-and-sms.md))
  is a `SettingsFrame` over `sms.enabled`, `sms.allowedCountries`, `sms.dailyMessageLimit`,
  `signIn.methods.smsCode` and `mfa.smsCode`: no save path of its own, and **a setting has
  one place** (Sign-in methods says whether each use of a texted code is on and links
  here; General settings has no SMS section). **What is asked about first is the
  contract's `settingsWeakenings`**, said by `describeWeakening`: never a rule of the
  screen's. A country is chosen from the contract's list (`SMS_COUNTRIES`, with
  `COUNTRY_CALLING_PREFIXES`), never typed, and an empty list is said to send nothing:
  never word or draw it as "every country". What a daily limit allows in an hour is the
  contract's `smsCostLimits`, and the limit is said to count messages, not segments or
  money. **The usage is the answer of `GET /v1/admin/sms/usage`, in the server's order**:
  never a rate, a trend, a sort or a sum of the screen's own, and its words say a count is
  of codes, not deliveries. A prefix from the server goes through `printable()` and names
  every country that shares it (`smsPrefixCountries`). **Whether the deployment has a
  sender is the `sms_sender` check of the instance diagnostics, shown in the server's
  words with its status as a word** (the summary leads; no tick, and never "the sender
  works": the check reads configuration and sends nothing): never inferred from a setting,
  never from a new route, kept for five minutes (`SENDER_NOTE_STALE_MS`: a run reads every
  environment's settings) and said to be that old, and the settings stay editable whatever
  it says. Taking a country out moves the focus to the country picker. The browser tests set the fixture's sender and
  counts through `/__test/sms-sender` and `/__test/sms-usage` (behind `e2e/guard.ts`).
- **The hooks screen** (`features/hooks`, [ADR 0035](../../docs/adr/0035-hooks.md), last
  section) draws the points, not a list, so a point with no hook is said. **Which changes
  are asked about first is the contract's `hookWeakenings`** (`weakeningSentences`), never
  a rule of the screen's own; in production the point's name is typed. The add and edit
  forms have no "enabled" field: the switch is an act with its own confirmation. **The
  screen says only what the server keeps of a hook's calls**: the four counts of
  `recentOutcomes` and its most recent call (`RecentOutcomes`), and the last call that
  failed with its reason (`LastFailure`). **What it may draw of a hook's calls is the four
  counts and the last outcome with its time, and nothing else**: the numbers are the
  answer's own, in one order, never a rate, a share, a trend or a sum of the screen's.
  **Never "failing now", "now" or "answering"**: the most recent call is said as *Last
  call answered*, *Last call failed* or *Last call timed out* (`hookHealth`, by the
  contract's `hookLastCallFailed`, never from `lastFailedAt` and never from the counts),
  with when it was, and with the sentence that one call does not say what a call made now
  would come to (for a hook that is off: that it has not been asked since); one nobody
  called is *Not called*. The window is "the current hour and the 23 before it", never
  "the last 24 hours". `words.test.ts` has the row of a failed last call 23 hours old.
  The row says what the counts are not.
  A hook is never called a webhook in its words (`features/hooks/words.test.ts`).
- **The proposals screen** (`features/proposals`, [ADR 0053](../../docs/adr/0053-proposals.md),
  "The dashboard's Proposals screen") lists what an agent asked for and approves with the
  dashboard's session. **It approves what it showed**: the request's operation and target
  are the snapshot the dialog was opened with, never the list read again, and the
  question's "About …" line is the card's line as text from that moment, never a live
  read. **The answer is shown before the list is read again** (the refresh is started and
  not awaited, as for a secret dialog); a proposal the screen has an answer about, and
  every card while an approval is on its way, cannot be asked about (only the card being
  approved is `aria-busy`). The question is
  the dashboard's own sentence (`consequenceOf` in `words.ts`); **an operation with no
  sentence has no Approve button**, and a new operation gets a row there in the change
  that adds it (`words.test.ts` runs the contract's lists: every operation, status, expiry
  reason, failure reason and approval refusal has words). In production the target's id is
  typed. **The status is the server's and the countdown is the screen's**: by the
  browser's clock, rounded down, never in a live region, and a time that ran out reads the
  list again and decides nothing. An outcome is said as it is: `changed: false` is
  "nothing changed", `failed` is never "carried out", `incomplete` says what is left to do
  and never "nothing was changed", and a failure that is no refusal of the proposal says
  the approval may have been taken. **Never "human verified", "reviewed" or any word that
  says a person looked** (a test scans the sources), and nothing an agent wrote is shown:
  a proposal holds none. **There is no dismissal**, on the screen or in the API (ADR 0053,
  "Dismissing a proposal: not built"); the screen says a proposal expires by itself and
  that revoking the key ends its proposals. The fake's routes
  (`src/testing/fake-proposals.ts`) are held to the contract and to the service's order of
  refusals by `fake-proposals.test.ts`: a change to `Proposals.approve`'s refusals or to
  `NOTHING_WHEN_ALREADY_SO` changes the fake.
- **Accessibility as in the React SDK**: labelled fields with associated, announced errors
  (`Field`), focus on the heading after a navigation (`PageHeader`), dialogs that trap and
  restore focus, state in words as well as colour, tables that stack under 640 px. Colours
  come from `@tula/contract/theme` through `tokens.gen.css`.
