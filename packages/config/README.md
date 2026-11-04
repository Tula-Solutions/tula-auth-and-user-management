# @tula-tech/config

`defineConfig()` for `tula.config.ts`: an environment's settings and OAuth providers of
[Tula Auth](../../README.md) as a typed, validated file that is reviewed and versioned like
code. `tula diff` and `tula apply` (`@tula-tech/cli`) make a server match it. See
[docs/config.md](../../docs/config.md).

```sh
bun add -d @tula-tech/config@latest @tula-tech/cli@latest
```

> **Early release (0.x).** The file's shape may change from one release to the next. Install it at the same version as `@tula-tech/cli`. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

```ts
import { defineConfig, env } from '@tula-tech/config'

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

## What a file can hold

Every key under an environment is optional. A file manages only what it names.

| Key | What it describes | Details |
| --- | --- | --- |
| `kind` | `'development'` or `'production'`; the CLI refuses a secret key of the wrong kind | [The file](../../docs/config.md#the-file) |
| `settings` | The environment's settings: app name, URLs, password policy, two-step verification, sessions | [docs/config.md](../../docs/config.md) |
| `providers` | OAuth providers (`google`, `apple`, `microsoft` and the others the server supports) | [docs/config.md](../../docs/config.md) |
| `webhooks` | Webhook endpoints. Absent means not managed; a list manages exactly what it names | [Webhook endpoints](../../docs/config.md#webhook-endpoints) |
| `hooks` | The questions the server asks your endpoints before a sign-up, a session and a token | [Hooks](../../docs/config.md#hooks) |
| `nativeApps` | iOS and Android apps registered for the environment | [Native apps](../../docs/config.md#native-apps) |
| `organizationRoles` | Custom organization roles | [Organization roles](../../docs/config.md#organization-roles) |

### What a missing field means

`tula apply` replaces the whole settings document, so the file is the truth: a setting you
leave out goes back to its default. Two exceptions keep what the server has, because their
default belongs to the deployment: `password` and `urls.allowedOrigins`. A provider the file does
not mention is left alone and shown as unmanaged; `tula apply --prune` deletes it. See
[What a missing field means](../../docs/config.md#what-a-missing-field-means).

## Exports

| Export | Use |
| --- | --- |
| `defineConfig(input)` | Types and validates a config at the call site. Returns it unchanged in shape. |
| `env(name)` | A reference to a secret held in an environment variable. |
| `isSecretRef(value)` | Whether a value is such a reference. |
| `loadConfig(path)` | Imports the file at `path` and validates it again; returns `{ path, config }`. |
| `parseConfig(value)` | Validates an already-loaded value; throws `ConfigError`. |
| `selectEnvironment(config, name)` | Picks one environment by its label (the only one, if `name` is undefined). |
| `requiredSecrets(providers)` | The variable name each provider needs, never a value. |
| `resolveSecret(ref, variables)` | Reads a reference's variable from `variables`; used by `tula apply`. |
| `hashEnvironmentConfig(environment)` | Async. The fingerprint `tula apply` records, computed over variable names. |
| `ConfigError`, `isConfigError` | The one error class, with a `code` and a list of issues (each has a path). |
| `DEFAULT_CONFIG_FILE` | `tula.config.ts`, the file name the CLI looks for. |

Every config type (`TulaConfig`, `EnvironmentConfig`, `WebhookEndpointConfig`,
`HooksConfig`, `NativeAppConfig`, `OrganizationRoleConfig`, ...) is exported too.

## Loading a file yourself

```ts
import { ConfigError, loadConfig, requiredSecrets, selectEnvironment } from '@tula-tech/config'

try {
  const { config } = await loadConfig('tula.config.ts')
  const prod = selectEnvironment(config, 'prod')
  console.log(requiredSecrets(prod.providers)) // { google: 'GOOGLE_CLIENT_SECRET' }
} catch (error) {
  if (error instanceof ConfigError) {
    // Each issue has the path of the problem, e.g. environments.prod.settings.pasword
    console.error(error.issues)
  }
  throw error
}
```

## Security notes

- **A secret is never in the file.** A literal string where a secret belongs is a type error
  and refused at load time. The error names the path and never repeats the value.
- **Webhook endpoints hold no secret at all.** Each endpoint's signing secret is made by the
  server and shown once; it is never written into the file.
- **The fingerprint says nothing about a secret's value.** It is computed with each secret
  as its variable's name.
- **The file is code that runs** when it is loaded, like a build script. Review changes to it
  the way you review code, and never load a file you do not trust.
- **A plan that weakens security needs a person or a flag.** `tula apply --yes` refuses to
  lower, for example, `mfa.policy` unless `--allow-weaker` is given as well.
  See [docs/config.md](../../docs/config.md).

## Compatibility

- Runs in Bun and in Node 22.18 or later (a TypeScript config needs one of these; a `.js`
  config loads anywhere). ESM only.
- Depends on Zod and on `@tula-tech/contract`, whose schemas it reuses. It is tooling and must
  never reach an application's bundle: install it as a development dependency.
- Keep it at the same version as `@tula-tech/cli`, which reads the file.

## Related packages

- [`@tula-tech/cli`](../cli/README.md): `tula diff` and `tula apply`, which make a server match
  this file.
- [`@tula-tech/contract`](../contract/README.md): the schemas the file is validated with.
- [`@tula-tech/admin`](../admin/README.md): the typed client the CLI writes through.

Full guide: [docs/config.md](../../docs/config.md).
