---
paths:
  - "apps/dashboard/**"
---

# Frontend rules (the dashboard, `apps/dashboard`)

These are for the dashboard application. `packages/react` is a library with different
constraints (no Tailwind, no generated API hooks): see `sdk.md`. The reasons are in
`apps/dashboard/README.md` and ADR 0032.

- Vite + React 19, TanStack Router (file-based) + Query, Tailwind v4 + shadcn, Zustand for
  client state (the selected scope and the session's status: ids and a status, never a
  secret).
- API access only through the Orval-generated hooks (`src/api/generated/api.gen.ts`,
  `bun run dashboard:generate` after `contract:generate`). Never call `fetch` from a
  component: `dashboardFetch` adds the dashboard header, never sends
  `Authorization`, and turns the envelope into `ApiError`.
- Generated, never edited by hand: `src/api/generated/**`, `src/routeTree.gen.ts`,
  `src/styles/tokens.gen.css`, and `src/components/ui/**` (shadcn's CLI: wrap or extend).
- The app is served under a strict Content-Security-Policy. No inline script or style, no
  `eval`, no library that injects a `<style>` element (check before adding one: Radix's
  dialog and select, and toast libraries, do). Dialogs are `components/modal.tsx` (the
  platform's `<dialog>`); keep `src/lib/zod-csp.ts` the first import of `main.tsx`.
- A route file's `validateSearch` and `beforeLoad`, and anything they import at module level,
  must not reach `zod` or `@tula/contract`'s schema modules: they run in the entry chunk,
  before `zod-csp.ts`, and the page then violates the policy. Read search parameters with a
  Zod-free reader (`features/webhooks/delivery-search.ts`) and add the route file to the
  import-walk test in `src/features/webhooks/words.test.ts`.
- A dialog whose answer carries a secret cannot be dismissed while its request is in flight
  (`Modal`'s `busy`, `SecretRequestActions`); refresh the list from the mutation hook's own
  `onSuccess`, started and not awaited (an awaited refresh keeps the secret off the screen
  until the list is back). `src/secret-dialogs.test.tsx` holds it.
- A confirmation's button stays unavailable from the click until its dialog closes: the
  mutation is no longer pending while the list is read again, and a second click would send
  the request again.
- An address from the server is shown through `features/webhooks/address.tsx` (`printable()`
  inside `<bdi dir="ltr">`), also in a dialog's title and in the text to type to confirm.
- Hooks (`features/hooks`) are not webhooks: never the word "webhook" for one. A change
  the contract's `hookWeakenings` names is asked about first (`WeakeningQuestion`, a stage
  of the dialog, typed in production); do not write a second rule. Show of a hook's calls
  only the last failure the server keeps, and say that is all.
- Native apps (`features/native-apps`, ADR 0040): what is asked about first is the
  contract's `nativeAppWeakenings` (`wideningSentences`), never a rule of the screen's own;
  a registration always is. Identifiers, teams and fingerprints from the server go through
  `printable()`. The form checks with the contract's schemas, and the two addresses shown
  are the environment's own (`associationUrls`).
- The address holds the selection and every filter; route files read parameters and pass
  them to a screen as props. Call `syncScope` in the `beforeLoad` of a route that has scope
  parameters.
- Local state must not survive a switch. The router keeps a component when only a path
  parameter changes: screens under the environment route are remounted by `EnvironmentGate`
  (keyed by the environment id), the workspace and user screens by their id; include the
  environment id in the key of a list item that holds form state; bind a dialog the shell
  owns to the scope it was opened in. A screen with a draft, a typed secret or a
  confirmation gets a test in `src/environment-switch.test.tsx`.
- A request belongs to the environment of the screen that made it. Give every generated admin
  hook `request: useEnvironmentRequest()` (`~/features/shell/environment-context`; it takes
  the call's other options, such as `If-Match`). `dashboardFetch` never reads the environment
  from the scope store and refuses an admin call that names none, or one that is no longer
  the selected one. Keep mutations on `networkMode: 'always'`: a write is never queued while
  offline and sent later. A new save path gets an offline-then-switch case in
  `src/environment-switch.test.tsx`.
- Leave for the sign-in page only after `DELETE /v1/instance/session` succeeded; a failed
  sign-out stays put and says the session is still active.
- A token, key, password or provider secret is component state only while its form or dialog
  is open. Give a mutation that carries one `gcTime: 0` and `reset()` it when the form lets
  go. Nothing goes to web storage, the address or a log.
- JWT templates (ADR 0036) are part of the session profiles screen's one draft
  (`features/settings/jwt-templates-section.tsx`). What the form can know it says before a
  save, with the contract's own functions (`isSessionProfileName` for a template's and a
  profile's name, `isCustomClaimKey`, `RESERVED_CLAIM_NAMES`,
  `jwtTemplateMaxBytes` and the caps): never a second copy of a rule. A weakening path gets
  a sentence in `describeWeakening` (`model.ts`), most specific pattern first.
- A profile's device binding (ADR 0043) is one select on its card, inside the same draft.
  Its hint says who the option reaches (native apps, never a browser) and that a change
  applies to new sign-ins only; a new profile takes `mobile`'s value. A session is said to
  be "bound to a device key", never verified or trusted (`.claude/hooks/wording.test.ts`
  reads the dashboard's sources).
- The Messages screen (`features/messages`, ADR 0042) edits `emails.templates` and
  `sms.templates` inside the one settings draft. Its preview is the answer of
  `POST /v1/admin/message-preview`, drawn as text nodes: no `dangerouslySetInnerHTML`, no
  `iframe`, no rendering in the browser. What a wording is refused for is the contract's
  validator (`problemsOf`); name hidden characters with `unseenCodePoints`.
- Settings screens are a `SettingsFrame` (one save model: `If-Match`, 412, weakening and
  managed-by confirmations). Do not write another save path.
- A destructive action goes through `ConfirmDialog`, names what it acts on, and passes
  `requireText` in a production environment.
- Server text is rendered as text: no `dangerouslySetInnerHTML`. A link is a route of the app
  or an `https:` URL checked with `isHttpsUrl`.
- kebab-case files, `function` declarations, JSDoc on exported components, hooks and
  functions.
- Colours only through the variables in `styles.css`, which come from `@tula/contract/theme`.
  No literal colour in a component.
- Every interactive element is keyboard-operable and labelled: `Field` / `TextField` /
  `SelectField` / `SwitchRow` for form controls, `ActionButton` for anything that can be
  pending, `PageHeader` for a screen's heading (it takes the focus after a navigation),
  `DataTable` for lists (it stacks under 640 px). State is said in words, not only colour.
- Tests: `bun test` in happy-dom with Testing Library, colocated; whole-app tests render
  through `src/testing/harness.tsx` against `src/testing/fake-api.ts`. Wait for a dialog to
  close with `waitFor(() => expect(openDialogs()).toBe(0))` and for focus with
  `expectFocus(element)`; never `expect(element)` inside `waitFor`. Coverage is per file.
- Browser tests live in `e2e/tests/dashboard/` and run the app as the API serves it. A new
  screen or state gets a scenario there with `expectScreenAccessible` (axe, light and dark,
  no rule disabled); the fixture's `problems` check (no CSP violation, no console error)
  runs on every test.
