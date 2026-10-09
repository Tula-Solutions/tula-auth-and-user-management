# Tula Auth documentation

Tula Auth is a self-hosted authentication and user-management server with SDKs for the web.
**Nothing is published yet**: no package is on npm and no image is in a registry, so
everything here is run from a checkout of the repository ([quickstart](quickstart.md)).

## Start here

| | |
| --- | --- |
| [Quickstart](quickstart.md) | From nothing to a signed-in user: build the image, pack the packages, `create-tula`, `tula dev`. |
| [Self-hosting](self-host.md) | The server's settings, an environment's settings, Redis and several instances, proxies, upgrades. |
| [What was not verified](plans/phase-1-unverified.md) | Everything in Phase 1 that was tested against a stand-in rather than the real thing. [Phase 2's list](plans/phase-2-unverified.md) is kept step by step. |

## Sign-in methods

One page each: how to switch it on (dashboard, `tula.config.ts`, admin API), what the user
sees, the security properties that matter to an integrator, the SDK calls, and troubleshooting
by error code. Their code samples are copied from files of this repository by
`bun run docs:generate`.

| Method | |
| --- | --- |
| [Password](methods/password.md) | Sign-up, sign-in, reset, the password policy. |
| [Emailed code](methods/email-code.md) | A 6-digit code; sign-up without a password. |
| [Emailed link](methods/email-link.md) | A link that works in the browser that asked for it. |
| [Texted code](methods/sms-code.md) | A 6-digit code by SMS, to a number the account has proven. Sign-in only; off by default. |
| [Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook](methods/oauth.md) | OAuth sign-in and connected accounts. Setup checklists: [Google](providers/google.md), [GitHub](providers/github.md), [Apple](providers/apple.md), [Microsoft](providers/microsoft.md), [Discord](providers/discord.md), [LinkedIn](providers/linkedin.md), [X](providers/x.md), [Facebook](providers/facebook.md). |
| [Passkeys](methods/passkeys.md) | WebAuthn: sign-in, second step, step-up. |
| [Two-step verification](methods/two-step-verification.md) | Authenticator app, backup codes, the policy, step-up. |
| [Sessions](methods/sessions.md) | Profiles, devices, the concurrent-session limit, what your server sees. |

## More about a user

| | |
| --- | --- |
| [Phone numbers](phone-numbers.md) | A number on an account, proven with a texted code: the `sms` setting and its country list, sending through Twilio ([setup checklist](providers/twilio.md)), the development SMS inbox, the SDK calls, your own wording for a text message and what it costs in segments, the error codes, and what is not built yet. |

## What your users are sent

| | |
| --- | --- |
| [Email templates](email-templates.md) | Your own subject and wording for each email: the kinds of message and their placeholders, what a template is refused for, the stricter rules of a security notice, what happens when a template cannot be used, and the preview. |

## Claims for your backend

| | |
| --- | --- |
| [JWT templates](jwt-templates.md) | Custom claims under `ext`: the sources a claim can have, the reserved names and the size cap, when a change takes effect, reading them with `@tula/nextjs`. |

## Events for your backend

| | |
| --- | --- |
| [Webhooks](webhooks.md) | Register an endpoint, the delivery's headers and body, verifying it with `@tula/admin`, what is stored, and what is not built yet (retries among them). |

## Questions for your backend

| | |
| --- | --- |
| [Hooks](hooks.md) | Register the hook asked before a sign-up, the question and the answer, verifying it with `@tula/admin`, the deadline, what a failed call does, and where the hook is and is not asked. |

## Tools

| | |
| --- | --- |
| [CLI](cli.md) | `create-tula`, `tula dev`, `tula doctor`, `tula policy test`, `tula diff`, `tula apply`, `tula mcp`. |
| [Settings as code](config.md) | `tula.config.ts`, what `diff` and `apply` do, using them in CI. |
| [Dashboard](dashboard.md) | The operator's screens at `/dashboard`. |
| [MCP server](mcp.md) | Read-only tools for an AI assistant. |
| [Conformance suite](../conformance/README.md) | The scenarios every server and SDK must pass, and how to run them against yours. |

## SDK reference

Generated from the JSDoc of every public entry point ([how](reference/README.md)):
[`@tula/core`](reference/core.md), [`@tula/react`](reference/react.md),
[`@tula/nextjs`](reference/nextjs.md), [`@tula/admin`](reference/admin.md),
[`@tula/config`](reference/config.md), [`@tula/contract`](reference/contract.md).

The packages' own READMEs are the guides: [`@tula/core`](../packages/core/README.md),
[`@tula/react`](../packages/react/README.md), [`@tula/nextjs`](../packages/nextjs/README.md),
[`@tula/admin`](../packages/admin/README.md), [`@tula/config`](../packages/config/README.md).
The example apps: [Next.js](../examples/nextjs-app-router/README.md),
[Vite + React](../examples/react-vite/README.md).

## For contributors

| | |
| --- | --- |
| [Architecture decisions](adr/) | One record per decision, with the reasoning the pages above link to. |
| [Phase 1 plan](plans/phase-1.md) | What was built, in what order, and the exit criteria with their evidence. |
| [Phase 2 plan](plans/phase-2.md) | Approved: webhooks, hooks, SMS, more providers, the Expo, Swift and Kotlin SDKs; the decisions it was started on. |
| [Releasing](releasing.md) | How the packages are built, packed and checked. |
| [Business plan](business-plan.md) | Product context. |
