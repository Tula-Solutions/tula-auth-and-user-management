# @tula/config

`defineConfig()` for `tula.config.ts`: an environment's settings and OAuth providers of
[Tula Auth](../../README.md) as a typed, validated file that is reviewed and versioned like
code. `tula diff` and `tula apply` (`@tula/cli`) make a server match it. See
[docs/config.md](../../docs/config.md).

```sh
bun add -d @tula/config@alpha @tula/cli@alpha
```

> **Alpha.** Released under the `alpha` dist-tag: the file's shape may change from one alpha
> to the next. Install it at the same version as `@tula/cli`. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

```ts
import { defineConfig, env } from '@tula/config'

export default defineConfig({
  environments: {
    prod: {
      kind: 'production',
      settings: {
        app: { name: 'Northline', supportEmail: 'help@northline.app' },
        urls: { allowedOrigins: ['https://app.northline.app'] },
        mfa: { policy: 'required' },
      },
      providers: {
        google: {
          clientId: '1234.apps.googleusercontent.com',
          clientSecret: env('GOOGLE_CLIENT_SECRET'),
        },
      },
    },
  },
})
```

- **Validated with the contract's schemas.** `settings` is the body of
  `PUT /v1/admin/settings`; an unknown key is an error with its path
  (`environments.prod.settings.pasword: unknown key`).
- **Secrets only by reference.** A provider's `clientSecret` or `privateKey` is
  `env('NAME')`. A literal string does not compile and is refused when the file is loaded; the
  error never repeats it. The variable is read by `tula apply`, when the provider is written.
- **Several environments in one file.** The name is a label for `--env`; which environment a
  run changes is decided by the secret key it is given. `kind` makes the CLI refuse a key of
  the other kind.
- `loadConfig(path)` imports the file (it is code its operator trusts) and validates it again.
  A TypeScript config needs Bun, or Node 22.18 or later; a `.js` config loads anywhere.

This package depends on Zod. It is for tooling (Node and Bun), never for an application's
bundle.
