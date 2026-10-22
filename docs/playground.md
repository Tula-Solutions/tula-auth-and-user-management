# Playground

Try the sign-in, sign-up and account components before you install anything: switch methods and providers on and off, change the look, break things on purpose, and copy the code for what you built. Everything runs in your browser against a sandbox that stands in for the Tula API.

## Try the components

:::playground{preset="full"}

A live sandbox of `<SignIn>`, `<SignUp>` and `<UserProfile>` with a panel to configure them. It needs a browser with script. Without it, the same screens are described in the guides for each [sign-in method](README.md#sign-in-methods).

:::

## What the sandbox is

The components on this page are the real ones from `@tula-tech/react`, and the client under them is the real `@tula-tech/core`. Only the server is replaced: a sandbox in the page answers the client's `/v1/client/*` requests with the shapes the API's contract defines and the rules it applies.

- **Nothing is sent anywhere.** The accounts, sessions, emails and passkeys are objects in the page's memory, gone when you leave it or press **Reset sandbox**. No token or secret is written to browser storage.
- **It says so.** Every playground is marked **Sandbox**, the consent screens are the sandbox's own and imitate no provider's page, and the passkey sheet says it is a simulation: the browser's passkey API is never called.
- **Errors are reachable.** A wrong password gives the same generic error for any address, five wrong ones lock the address for a short while, a code can be wrong, reused or expired (mark it expired in the inbox), an emailed link can be opened in another browser, and a provider can be declined.
- **Not everything is simulated.** Step-up for sensitive actions, texted codes and phone numbers, signing in with a native ID token, password expiry and a passkey as a second step answer with the error the API gives where the method is off. They are described in the [guides](README.md#sign-in-methods) and covered by the conformance scenarios the repository runs against the real server.

## Accounts and codes

| Account | Password | What it has |
| --- | --- | --- |
| `ada@example.test` | `Sandbox-pass-42!` | A password. No second step. |
| `grace@example.test` | `Sandbox-pass-42!` | A password and an authenticator app, with backup codes `sbx1-aaaa` to `sbx1-dddd`. |

The **Accounts and codes** tab under the frame shows the six-digit code of every authenticator app in the sandbox, including one you enrol yourself. The **Inbox** tab holds the emails the sandbox "sent": codes to copy, links to open.

## Take it with you

Under the frame are three files, written from your choices as you make them.

- **React** is the page: the provider with the URLs a sign-in needs, and the component. Follow the [quickstart](quickstart.md) to get a project it fits into.
- **CSS** holds only the theme tokens you changed. The [React SDK reference](reference/react.md) lists them all, and the components keep their defaults for the rest.
- **Config** is a `tula.config.ts` that sets an environment the way the sandbox is set: the methods, the providers (their secrets only as `env('NAME')`) and the two-step policy. Apply it with `tula apply` ([config.md](config.md)).
