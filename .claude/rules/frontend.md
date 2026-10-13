---
paths:
  - "apps/dashboard/**"
---

# Frontend rules (the dashboard, `apps/dashboard`)

These are for the dashboard application. `packages/react` is a library with different
constraints (no Tailwind, no generated API hooks): see `react.md`. The reasons are in
`apps/dashboard/README.md` and ADR 0032. **The dashboard's rules are in `dashboard.md`**, which
loads with this file; here is only what it does not say.

- Vite + React 19, TanStack Router (file-based) + Query, Tailwind v4 + shadcn, Zustand for
  client state (the selected scope and the session's status: ids and a status, never a
  secret).
- Never call `fetch` from a component.
- Check before adding a library whether it injects a `<style>` element (toast libraries do).
- Read a route's search parameters with a Zod-free reader
  (`features/webhooks/delivery-search.ts`).
- Route files read parameters and pass them to a screen as props.
- A request belongs to the environment of the screen that made it. Give every generated admin
  hook `request: useEnvironmentRequest()` (`~/features/shell/environment-context`; it takes
  the call's other options, such as `If-Match`). `dashboardFetch` never reads the environment
  from the scope store and refuses an admin call that names none, or one that is no longer
  the selected one. Keep mutations on `networkMode: 'always'`: a write is never queued while
  offline and sent later. A new save path gets an offline-then-switch case in
  `src/environment-switch.test.tsx`.
- Hooks (`features/hooks`): a change the contract's `hookWeakenings` names is asked about
  through `WeakeningQuestion`, a stage of the dialog.
- Link paths and custom-scheme redirect URLs (ADR 0044): a gained link path is asked about
  through the same `wideningSentences`, and the Android sentence says the file lets the app
  claim every link of the domain, never "these paths". A custom-scheme redirect URL added
  on the general settings screen is the settings weakening `urls.allowedRedirectUrls`
  (`describeWeakening` has its sentence); the screen has no rule of its own for either.
- Native apps (`features/native-apps`, ADR 0040): what is asked about first is the
  contract's `nativeAppWeakenings` (`wideningSentences`), never a rule of the screen's own;
  a registration always is. Identifiers, teams and fingerprints from the server go through
  `printable()`. The form checks with the contract's schemas, and the two addresses shown
  are the environment's own (`associationUrls`).
- JWT templates (ADR 0036) are part of the session profiles screen's one draft
  (`features/settings/jwt-templates-section.tsx`). What the form can know it says before a
  save, with the contract's own functions (`isSessionProfileName` for a template's and a
  profile's name, `isCustomClaimKey`, `RESERVED_CLAIM_NAMES`,
  `jwtTemplateMaxBytes` and the caps): never a second copy of a rule. A weakening path gets
  a sentence in `describeWeakening` (`model.ts`), most specific pattern first.
- A profile's device binding (ADR 0043) is one select on its card, inside the same draft.
  Its hint says who the option reaches (native apps, never a browser) and that a change
  applies to new sign-ins only (`device-binding.md` has the words a session is said in).
- The Text messages screen owns the SMS settings: another screen says their state and
  links to it with `EnvironmentLink`, never a second control.
- Whether a production environment accepts an agent's proposals (ADR 0053) is one switch
  on the general settings screen ("AI agents"), inside the same draft. Switching it on is
  the contract's weakening `agents.proposalsInProduction`, said by `describeWeakening`;
  the screen has no rule of its own.
- No `dangerouslySetInnerHTML` anywhere. A link's `https:` URL is checked with `isHttpsUrl`.
- Colours only through the variables in `styles.css`. No literal colour in a component.
- Every interactive element is keyboard-operable and labelled: `Field` / `TextField` /
  `SelectField` / `SwitchRow` for form controls, `ActionButton` for anything that can be
  pending, `PageHeader` for a screen's heading, `DataTable` for lists.
- Tests: `bun test` in happy-dom with Testing Library, colocated; whole-app tests render
  through `src/testing/harness.tsx` against `src/testing/fake-api.ts`. Wait for a dialog to
  close with `waitFor(() => expect(openDialogs()).toBe(0))` and for focus with
  `expectFocus(element)`; never `expect(element)` inside `waitFor`. Coverage is per file.
- Browser tests live in `e2e/tests/dashboard/` (`e2e.md`). A new screen or state gets a
  scenario there with `expectScreenAccessible` (axe, light and dark, no rule disabled); the
  fixture's `problems` check (no CSP violation, no console error) runs on every test.
