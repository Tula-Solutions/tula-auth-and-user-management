# The dashboard

The dashboard is a web app for the operator of a deployment. The API serves it at
`/dashboard` (the image ships it; nothing else to deploy), and it manages the same things the
admin API and the CLI do: workspaces, projects and environments; users and their sessions;
sign-in methods and OAuth providers; the password policy and session profiles; API keys and
signing keys; webhook endpoints and their deliveries; the audit logs; and the deployment's
diagnostics.

How it is built and tested: [apps/dashboard/README.md](../apps/dashboard/README.md). The
session, its CSRF rules and how the app is served: [ADR 0032](adr/0032-dashboard.md).

## Signing in

1. Set `TULA_ADMIN_TOKEN` in the API's environment (`openssl rand -hex 32`) and restart it.
   Without it the dashboard is switched off: the sign-in page says so, and
   `/v1/instance/*` does not exist.
2. Open `https://<your API>/dashboard/` and paste the token.

The token is exchanged once for a session that lasts eight hours. The browser holds an
HttpOnly cookie it cannot read; the token itself is not kept anywhere. When the session ends
the dashboard returns to sign-in and comes back to the page you were on. Rotating
`TULA_ADMIN_TOKEN` ends every dashboard session at once: that is how to respond to a leaked
token or a lost laptop.

Open the dashboard from the API's own address (`PUBLIC_URL`). Behind another origin the API
refuses its requests.

## Finding your way

- **Workspace → project → environment.** The workspace is chosen at the top of the
  navigation, a project in the list under it, and the environment with the switcher at the
  top right. Each project has a development and a production environment, with separate
  users, keys and settings. The badge next to the switcher says which one you are in;
  production says so in words.
- **The address holds the selection.** A link to any screen can be shared, and a reload
  stays where it was.
- **In production, destructive actions ask you to type** the user's email or the key's name.

A deployment that was never seeded has no workspace: the dashboard offers to create one, then
a project (which gets both environments). Create its first keys under **API keys**. Nothing
deletes a workspace, project or environment yet.

## Screens

| Screen | What you can do |
| --- | --- |
| Users | Search by email or name; create a user; open one. |
| A user | Profile and state; how they sign in (password, verified address, linked accounts, two-step verification and backup codes left, passkeys: never a secret); active sessions (revoke one or all); recent audit entries; set a new password; reset two-step verification; ban or unban; delete. |
| Sign-in methods | Switch password, emailed code, emailed link and passkeys on or off; set the passkey domain; whether sign-up needs a password; the two-step verification policy; configure Google, GitHub, Apple and Microsoft. |
| Password policy | A preset or custom rules. |
| Session profiles | Lifetimes per profile, custom profiles, and the limit on concurrent sessions. **JWT templates** ([docs](jwt-templates.md)): add a template and its claims (a source or a fixed value each), see how large it can get against the 1,024-byte cap and which profiles use it, and choose a template on a profile's card. A reserved or malformed claim name and the caps are refused in the form; a template a profile uses cannot be taken out until the profile lets go of it; a save that takes claims away from a profile's sessions asks first. |
| API keys | List (prefix and last four characters only), create, revoke. |
| Signing keys | List with status; rotate. |
| Webhooks | List an environment's webhook endpoints with how each is doing; add one (its signing secret is shown once), change its address and event types, switch it off and on, rotate its secret, send a test event, delete it. |
| A webhook endpoint | The endpoint, and the log of what was sent to it: one row per delivery, filtered by state and event type. |
| A delivery | Every request the server made for it (status code, duration, time, and why one failed), and "Send again". |
| Hooks | The three points at which the server asks your backend a question (`before_sign_up`, `before_session`, `before_token`), each with its hook or none: its address, whether it is on, its deadline, what happens when a call fails, and the last call that failed. Add a hook (its signing secret is shown once), change it, switch it off and on, remove it. |
| Audit log | An environment's entries, filtered by action, actor type, actor, target and day. |
| Settings | App name, support address, allowed origins and redirect URLs, security notices, audit retention. |
| Instance audit log | Dashboard sign-ins, and workspaces, projects and environments being created. |
| Diagnostics | The checks `tula doctor` runs, each with its fix. |

### Things worth knowing

- **A new API key is shown once.** Copy it from the dialog; closing the dialog discards it,
  and the API cannot show it again.
- **An OAuth secret is write-only.** After saving, the form says a secret is saved and offers
  "Replace secret"; it never shows the old one. The redirect URI to register with the
  provider is shown on each provider's card.
- **Setting a password** ends every session of that user and emails them a notice. An admin
  never sees an existing password. Policy errors are listed in the dialog.
- **Resetting two-step verification** removes the user's authenticator, backup codes and
  passkeys. When that would leave the user no way to sign in, the confirmation says so before
  you reset; afterwards the dashboard says whether the user can still sign in with what is
  left. If not, set a password for them.
- **Rotating signing keys** signs nobody out. A key published moments ago cannot be activated
  yet, so a second rotation within ten minutes is refused.
- **At least one sign-in method must stay on.** Switching off the last one (counting enabled
  providers) is refused by the server, and the dashboard says so.
- **A webhook signing secret is shown once**, when the endpoint is added and when its secret
  is rotated. Copy it from the dialog; closing the dialog discards it, and the API cannot
  show it again. If it is lost, rotate. While the request is under way the dialog cannot be
  closed (Cancel says why, Escape does nothing): the server has made the secret by the time
  it answers, and the answer is the only place it is. The same holds for a new API key.
  Leaving the page during that moment still loses the secret; the endpoint is then in the
  list, and its secret is rotated to get one.
- **Rotating a webhook secret breaks nothing at once.** For 24 hours every delivery is signed
  with the new secret and the previous one, and the endpoint's card says until when. "End
  the overlap now" stops the previous secret at once: use it once your receiver has the new
  one, or when the old one leaked. It names the endpoint and, in a production environment,
  asks for its address to be typed, as deleting does. A second rotation waits until the
  overlap is over.
- **An address is shown so that it can be checked by eye.** A character nobody can see, or
  one that turns the text round (a zero-width space, a right-to-left override), is written
  out as `\u{…}` with its code point, wherever the address appears; so is a mark that is
  drawn on the character before it (a stroke laid over a slash, an accent that is a
  character of its own), and a backslash, so two addresses are shown alike only when they
  are the same. To confirm by typing, type what is shown. In the form that adds or changes
  an endpoint the field holds the address as it is, and the written-out form appears under
  it when the two differ. The price: an address that holds text of a script written with
  such marks as itself, and not in Punycode or percent escapes, is shown with escapes in
  it. Letters of different scripts that look alike are not told apart.
- **An endpoint the server switched off says why**: it answered `410 Gone`, or requests to it
  failed for five days. Fix the receiver, send a test event, then switch the endpoint on.
- **A test event changes nothing about an endpoint.** It carries `"test": true`, is sent
  once, and neither counts as a failure nor ends a run of failures. "Send again" on a
  delivery is one request too, with the same event and id; if it gets through it does end
  the run. Both share a limit of ten requests a minute per environment, beside the admin
  API's general one; a refusal for too many requests says how long to wait, not which of
  the two it was, because the server's answer does not say.
- **Where the webhook worker is a service of its own** (`WEBHOOK_WORKER=separate`,
  [self-host.md](self-host.md#the-webhook-worker-as-its-own-service)), a test event and
  "Send again" are refused, and the dashboard says so in words: this deployment delivers
  webhooks from a separate worker, so neither can be done from here. Nothing is sent and
  nothing is recorded. Real events are delivered by that worker, to an endpoint that is
  switched on and subscribed to their type, and a pending delivery is retried by it; the
  endpoint's deliveries show them. The refusal says how the deployment is set up, not that
  a worker is running.
- **An address that names nothing reads "not found"**: an endpoint or a delivery that was
  deleted, one of another environment, and an id that is no id at all (a mistyped address)
  alike, with the way back to the list. A page past the newest 10,000 deliveries, which the
  server does not page beyond, is read as the first page.
- **Some event types are explained where they are chosen**: the three `hook.*` types are
  about hooks (a question asked before a sign-up), not webhooks, and say so; so do
  `signing_key.rotated`, `webhook_endpoint.secret_rotated`, `webhook_endpoint.disabled` and
  `session.reuse_detected`.
- **Deleting an endpoint deletes its delivery log** and its pending deliveries with it.

More about webhooks: [webhooks.md](webhooks.md).

Hooks ([hooks.md](hooks.md)) are a different thing from webhooks, on a screen of their own:

- **A hook is a question, and its answer decides.** The screen always lists the three
  points, so a point with no hook says "nothing is asked at this point" instead of being
  absent.
- **What lets through is asked about first.** Choosing "let it through" for when a call
  fails, switching a hook off, and removing a hook that is on each take away a check, and
  the server records each as a weakening. The dashboard uses the server's own rule for
  which changes those are, says in a sentence what is let through at that point (a sign-up,
  a sign-in, a session without the hook's claims), and in a production environment asks for
  the point's name to be typed. Adding a hook that refuses on failure, switching one on and
  removing one that is already off are not weakenings; removing still deletes the signing
  secret, so in production it is typed too.
- **"Recent outcomes" is the last call that failed, and the screen says that is all.** The
  server keeps when a call of the hook last failed and a fixed word for why; "no answer
  within the deadline" is shown as *Timed out*, anything else as *Failed*. It keeps nothing
  of a call that was answered, so there is no count of what a hook allowed or denied, and an
  old failure is not "failing now": it stays until another call fails.
- **The signing secret is shown once**, in the dialog that added the hook, and cannot be
  shown again or rotated. If it is lost, remove the hook and add it again.
- **A point or a word a later server knows** is shown as the text it is. Such a hook can be
  switched off, switched on and removed, but not edited.

## Saving settings

Every settings screen works the same way: change the form, then **Save changes**.

- **Changed elsewhere.** If someone else (or `tula apply`) saved the settings after you
  opened them, your save is refused rather than overwriting theirs. Reload the settings and
  make your change again.
- **This weakens security.** A change that makes accounts easier to take over (a shorter
  minimum password, a switched-off security notice, a looser two-step policy, longer
  sessions) asks for confirmation and lists what gets weaker. The audit entry records
  `weakened: true`.
- **This deletes older audit entries for good.** Setting an audit retention period where
  there was none, or a shorter one, asks in those words: starting with its next retention
  run (they run every ten minutes, and a large backlog takes several) the server deletes
  every audit entry of the environment older than the new period, and nothing brings them
  back. A longer period, or none, saves without asking. It is recorded
  as a weakening too.
- **Managed by a config file.** When the settings were applied with `tula apply`
  ([config.md](config.md)), a banner says so on every settings screen. You can still edit
  them, after a confirmation; the change is then reported as drift, and the next
  `tula apply` puts the file's values back.

## Audit

Everything the dashboard changes in an environment is recorded in that environment's audit
log with the actor type `instance_admin` and the id of the dashboard session that did it.
Filter the audit log by "Actor type: instance_admin" to see what was done from the dashboard.

Failed sign-ins to the dashboard are in the instance audit log, at most one entry a minute
per address; each says how many failures from that address in the minute before were not
recorded one by one. The instance audit log is kept for `INSTANCE_AUDIT_RETENTION_DAYS`
(a year by default); an environment's audit log is kept for good unless its settings give
it a retention period, and entries older than that are then deleted permanently.

## Switching and signing out

- Switching environment, project, workspace or user discards what was typed and not saved on
  the screen you leave: a settings draft, a half-typed provider secret, a webhook secret
  still on screen, an open confirmation.
  Nothing typed for one environment can be saved to another.
- If signing out fails (the API did not answer), the dashboard stays where it is and says
  that you are still signed in. Choose "Sign out" again; until it succeeds the session in
  this browser is active.

## Security notes for operators

- The dashboard is as powerful as `TULA_ADMIN_TOKEN`: whoever signs in can manage every
  environment of the deployment. Serve the API over HTTPS, and treat the token like a root
  password.
- It is served under a strict Content-Security-Policy (no inline script or style, no other
  origin) and cannot be framed.
- The API reference at `/v1/docs` is on the same origin. It is off by default in `staging`
  and `prod` (`API_DOCS`), loads no script from another host and has its own
  Content-Security-Policy. Behind a proxy, set `TRUST_PROXY=true`, or every client shares
  one sign-in allowance.
- A session cannot be revoked alone; signing out clears the cookie in that browser, and
  rotating the token ends them all.
- To run the API without the dashboard, leave `TULA_ADMIN_TOKEN` unset (no sign-in is
  possible), or point `DASHBOARD_DIR` at an empty directory (the files are not served).
