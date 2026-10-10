import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type AndroidAppConfig,
  type ConfigError,
  defineConfig,
  type EnvironmentSettingsConfig,
  env,
  hashEnvironmentConfig,
  isConfigError,
  isSecretRef,
  loadConfig,
  providerSecret,
  requiredSecrets,
  resolveSecret,
  secretKeyMatchesKind,
  selectEnvironment,
  type TulaConfigInput,
} from './index'

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name)

function refusal(build: () => unknown): ConfigError {
  try {
    build()
  } catch (error) {
    if (isConfigError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the config to be refused')
}

async function failure(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise
  } catch (error) {
    if (isConfigError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the load to fail')
}

/** A config as a file might hold it when it bypasses the types. */
function untyped(value: unknown): TulaConfigInput {
  return value as TulaConfigInput
}

describe('env', () => {
  test('is a reference to a variable, never its value', () => {
    const ref = env('GOOGLE_CLIENT_SECRET')
    expect(isSecretRef(ref)).toBe(true)
    expect(ref.$env).toBe('GOOGLE_CLIENT_SECRET')
    expect(JSON.stringify(ref)).toBe('{"$env":"GOOGLE_CLIENT_SECRET"}')
  })

  test.each(['', 'lower_case', '1LEADING', 'WITH SPACE', 'A=B'])(
    'refuses %p as a variable name',
    (name) => {
      expect(refusal(() => env(name)).code).toBe('config.invalid')
    }
  )

  test.each([
    ['a string', 'x'],
    ['null', null],
    ['an object with more keys', { $env: 'A', other: 1 }],
    ['a non-string name', { $env: 1 }],
  ])('isSecretRef is false for %s', (_name, value) => {
    expect(isSecretRef(value)).toBe(false)
  })
})

describe('defineConfig', () => {
  test('fills the settings’ defaults and keeps the two deployment defaults absent', () => {
    const config = defineConfig({
      environments: { dev: { settings: { app: { name: 'Northline' } } }, prod: {} },
    })
    const dev = config.environments.dev
    expect(dev?.settings.app.name).toBe('Northline')
    expect(dev?.settings.mfa.policy).toBe('optional')
    expect(dev?.settings.signIn.methods.password.enabled).toBe(true)
    // Left out means "the deployment's": only the server knows those.
    expect(dev?.settings.password).toBeUndefined()
    expect(dev?.settings.urls.allowedOrigins).toBeUndefined()
    expect(dev?.providers).toEqual({})
    expect(config.environments.prod?.settings.app.name).toBe('Tula')
  })

  test('accepts every provider with its secret by reference', () => {
    const config = defineConfig({
      environments: {
        prod: {
          kind: 'production',
          providers: {
            google: { clientId: 'g', clientSecret: env('GOOGLE_CLIENT_SECRET') },
            github: { clientId: 'gh', clientSecret: env('GITHUB_CLIENT_SECRET'), enabled: false },
            apple: {
              clientId: 'app.northline.web',
              teamId: 'TEAM123456',
              keyId: 'KEY1234567',
              privateKey: env('APPLE_PRIVATE_KEY'),
            },
            microsoft: {
              clientId: 'ms-client',
              clientSecret: env('MICROSOFT_CLIENT_SECRET'),
              tenant: '72F988BF-86F1-41AF-91AB-2D7CD011DB47',
            },
          },
        },
      },
    })
    const prod = config.environments.prod
    expect(prod?.kind).toBe('production')
    // The tenant is stored as the server stores it: lower-cased.
    expect(prod?.providers.microsoft).toEqual({
      clientId: 'ms-client',
      clientSecret: { $env: 'MICROSOFT_CLIENT_SECRET' },
      tenant: '72f988bf-86f1-41af-91ab-2d7cd011db47',
      enabled: true,
    })
    expect(prod?.providers.google).toEqual({
      clientId: 'g',
      clientSecret: { $env: 'GOOGLE_CLIENT_SECRET' },
      enabled: true,
    })
    expect(prod?.providers.github?.enabled).toBe(false)
    expect(requiredSecrets(prod?.providers ?? {})).toEqual({
      apple: 'APPLE_PRIVATE_KEY',
      github: 'GITHUB_CLIENT_SECRET',
      google: 'GOOGLE_CLIENT_SECRET',
      microsoft: 'MICROSOFT_CLIENT_SECRET',
    })
  })

  test.each([
    ['common', 'common'],
    ['organizations', 'organizations'],
    ['consumers', 'consumers'],
    [' Common ', 'common'],
    ['9188040d-6c67-4c5b-b112-36a304b66dad', '9188040d-6c67-4c5b-b112-36a304b66dad'],
  ])('Microsoft’s tenant %p is accepted as %p', (tenant, stored) => {
    const config = defineConfig({
      environments: {
        dev: {
          providers: { microsoft: { clientId: 'c', clientSecret: env('MS'), tenant } },
        },
      },
    })
    expect(config.environments.dev?.providers.microsoft?.tenant).toBe(stored)
  })

  test.each([
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['an address of the authority', 'https://login.microsoftonline.com/common'],
    ['a path', 'common/v2.0'],
    ['a template', '{tenantid}'],
    ['a short id', '72f988bf-86f1-41af-91ab'],
    ['nothing', ''],
    ['a number', 7],
  ])('Microsoft’s tenant is refused when it is %s, without repeating it', (_name, tenant) => {
    const input = {
      environments: {
        dev: {
          providers: { microsoft: { clientId: 'c', clientSecret: { $env: 'MS' }, tenant } },
        },
      },
    }
    const error = refusal(() => defineConfig(input as never))
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'environments.dev.providers.microsoft.tenant',
    ])
    if (typeof tenant === 'string' && tenant.length > 3) {
      expect(JSON.stringify([error.message, error.issues])).not.toContain(tenant)
    }
  })

  test('Microsoft’s client secret is a reference, as every secret is', () => {
    const literal = 'literal-microsoft-secret-123'
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            providers: {
              // @ts-expect-error a secret is never a string in a config file
              microsoft: { clientId: 'c', clientSecret: literal, tenant: 'common' },
            },
          },
        },
      })
    )
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'environments.dev.providers.microsoft.clientSecret',
    ])
    expect(JSON.stringify([error.message, error.issues])).not.toContain(literal)
  })

  describe.each(['discord', 'linkedin', 'x', 'facebook'] as const)('%s', (provider) => {
    test('takes a client id and a secret reference, and is on unless the file says otherwise', () => {
      const config = defineConfig({
        environments: {
          dev: { providers: { [provider]: { clientId: ' c ', clientSecret: env('THE_SECRET') } } },
        },
      })
      const dev = selectEnvironment(config, 'dev')
      expect(dev.providers[provider]).toEqual({
        clientId: 'c',
        clientSecret: { $env: 'THE_SECRET' },
        enabled: true,
      })
      expect(requiredSecrets(dev.providers)).toEqual({ [provider]: 'THE_SECRET' })
      expect(providerSecret(dev.providers, provider)).toEqual({ $env: 'THE_SECRET' })
    })

    test('a literal secret is refused without repeating it', () => {
      const literal = 'literal-provider-secret-123'
      const error = refusal(() =>
        defineConfig(
          untyped({
            environments: {
              dev: { providers: { [provider]: { clientId: 'c', clientSecret: literal } } },
            },
          })
        )
      )
      expect(error.issues.map((issue) => issue.path)).toEqual([
        `environments.dev.providers.${provider}.clientSecret`,
      ])
      expect(JSON.stringify([error.message, error.issues])).not.toContain(literal)
    })

    test.each([
      ['Microsoft’s tenant', { tenant: 'common' }],
      ['Apple’s team id', { teamId: 'TEAM123456' }],
      ['a field nobody has', { scopes: ['guilds'] }],
    ])('%s is not a field of it', (_name, extra) => {
      const error = refusal(() =>
        defineConfig(
          untyped({
            environments: {
              dev: {
                providers: { [provider]: { clientId: 'c', clientSecret: { $env: 'S' }, ...extra } },
              },
            },
          })
        )
      )
      expect(error.issues.map((issue) => issue.path)).toEqual([
        `environments.dev.providers.${provider}.${Object.keys(extra)[0]}`,
      ])
    })
  })

  test('a literal secret is a type error and a run-time error that does not repeat it', () => {
    const literal = 'literal-secret-value-123'
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            providers: {
              // @ts-expect-error a secret must be env('NAME'), never a string
              google: { clientId: 'g', clientSecret: literal },
              apple: {
                clientId: 'a',
                teamId: 't',
                keyId: 'k',
                // @ts-expect-error a private key must be env('NAME'), never a string
                privateKey: literal,
              },
            },
          },
        },
      })
    )
    expect(error.code).toBe('config.invalid')
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'environments.dev.providers.google.clientSecret',
      'environments.dev.providers.apple.privateKey',
    ])
    expect(error.issues[0]?.message).toContain("env('")
    expect(error.message).not.toContain(literal)
    expect(JSON.stringify(error)).not.toContain(literal)
    expect(Bun.inspect(error)).not.toContain(literal)
  })

  test.each([
    [
      'a misspelt section',
      { environments: { dev: { settings: { pasword: {} } } } },
      'environments.dev.settings.pasword',
      'unknown key',
    ],
    [
      'an unknown key at the top',
      { environments: { dev: {} }, enviroments: {} },
      'enviroments',
      'unknown key',
    ],
    [
      'an unknown key in an environment',
      { environments: { dev: { setings: {} } } },
      'environments.dev.setings',
      'unknown key',
    ],
    [
      'an unknown provider',
      { environments: { dev: { providers: { twitch: { clientId: 'x' } } } } },
      'environments.dev.providers.twitch',
      'unknown key',
    ],
    [
      'an unknown key in a nested section',
      { environments: { dev: { settings: { signIn: { methods: { sms: { enabled: true } } } } } } },
      'environments.dev.settings.signIn.methods.sms',
      'unknown key',
    ],
    [
      'a value the contract refuses',
      { environments: { dev: { settings: { mfa: { policy: 'sometimes' } } } } },
      'environments.dev.settings.mfa.policy',
      '',
    ],
    [
      'a password policy below the floor',
      { environments: { dev: { settings: { password: { minLength: 4 } } } } },
      'environments.dev.settings.password',
      '',
    ],
    [
      'an environment name that is not a slug',
      { environments: { 'Dev Env': {} } },
      'environments.Dev Env',
      'name',
    ],
    ['no environments', { environments: {} }, 'environments', 'at least one'],
    [
      'Apple without its team id',
      {
        environments: {
          dev: { providers: { apple: { clientId: 'a', keyId: 'k', privateKey: { $env: 'A' } } } },
        },
      },
      'environments.dev.providers.apple.teamId',
      '',
    ],
    [
      'Microsoft without its tenant',
      {
        environments: {
          dev: { providers: { microsoft: { clientId: 'c', clientSecret: { $env: 'M' } } } },
        },
      },
      'environments.dev.providers.microsoft.tenant',
      '',
    ],
    ['not an object at all', 'nope', '', ''],
  ])('refuses %s with its path', (_name, input, path, message) => {
    const error = refusal(() => defineConfig(untyped(input)))
    expect(error.code).toBe('config.invalid')
    const issue = error.issues.find((candidate) => candidate.path.startsWith(path))
    expect(issue).toBeDefined()
    expect(issue?.message).toContain(message)
    expect(error.message).toContain(path)
  })

  test('validating twice gives the same config (defineConfig, then loadConfig)', () => {
    const once = defineConfig({
      environments: {
        dev: { providers: { google: { clientId: 'g', clientSecret: env('G') } } },
      },
    })
    expect(defineConfig(once as TulaConfigInput)).toEqual(once)
  })
})

describe('selectEnvironment', () => {
  const config = defineConfig({ environments: { dev: {}, prod: {} } })

  test('returns the named environment', () => {
    expect(selectEnvironment(config, 'prod')).toBe(config.environments.prod as never)
  })

  test('with one environment the name may be left out', () => {
    const single = defineConfig({ environments: { only: {} } })
    expect(selectEnvironment(single, undefined)).toBe(single.environments.only as never)
  })

  test('with several the name is required, and the error lists them', () => {
    const error = refusal(() => selectEnvironment(config, undefined))
    expect(error.code).toBe('config.environment_required')
    expect(error.message).toContain('dev, prod')
  })

  test('an unknown name lists the ones the file has, and inherited names are not found', () => {
    expect(refusal(() => selectEnvironment(config, 'staging')).code).toBe(
      'config.environment_unknown'
    )
    expect(refusal(() => selectEnvironment(config, 'constructor')).code).toBe(
      'config.environment_unknown'
    )
  })
})

describe('resolveSecret', () => {
  test('reads the variable', () => {
    expect(resolveSecret(env('A_SECRET'), { A_SECRET: 'value' })).toBe('value')
  })

  test.each([
    ['unset', {}],
    ['empty', { A_SECRET: '' }],
    ['blank', { A_SECRET: '   ' }],
  ])('a variable that is %s is an error naming the variable', (_name, variables) => {
    const error = refusal(() => resolveSecret(env('A_SECRET'), variables))
    expect(error.code).toBe('config.secret_missing')
    expect(error.message).toContain('A_SECRET')
  })
})

describe('secretKeyMatchesKind', () => {
  test.each([
    ['development', 'tula_sk_dev_abc', true],
    ['development', 'tula_sk_prod_abc', false],
    ['production', 'tula_sk_prod_abc', true],
    ['production', 'tula_sk_dev_abc', false],
    [undefined, 'tula_sk_dev_abc', true],
    [undefined, 'anything', true],
  ] as const)('%p with %p is %p', (kind, key, expected) => {
    expect(secretKeyMatchesKind(kind, key)).toBe(expected)
  })
})

describe('hashEnvironmentConfig', () => {
  test('is stable across key order and changes with the content', async () => {
    const one = defineConfig({
      environments: {
        dev: {
          settings: { app: { name: 'A' }, mfa: { policy: 'required' } },
          providers: { google: { clientId: 'g', clientSecret: env('G') } },
        },
      },
    }).environments.dev
    const two = defineConfig({
      environments: {
        dev: {
          providers: { google: { clientSecret: env('G'), clientId: 'g' } },
          settings: { mfa: { policy: 'required' }, app: { name: 'A' } },
        },
      },
    }).environments.dev
    const other = defineConfig({
      environments: { dev: { settings: { app: { name: 'B' } } } },
    }).environments.dev
    if (!one || !two || !other) {
      throw new Error('fixture')
    }
    const hash = await hashEnvironmentConfig(one)
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await hashEnvironmentConfig(two)).toBe(hash)
    expect(await hashEnvironmentConfig(other)).not.toBe(hash)
  })
})

describe('loadConfig', () => {
  test('imports a TypeScript config and validates it', async () => {
    const loaded = await loadConfig(fixture('valid.config.ts'))
    expect(loaded.path).toBe(fixture('valid.config.ts'))
    expect(loaded.config.environments.dev?.settings.app.name).toBe('Northline (dev)')
    expect(loaded.config.environments.dev?.providers.github?.clientSecret).toEqual({
      $env: 'GITHUB_CLIENT_SECRET',
    })
  })

  test('validates a config that did not go through defineConfig', async () => {
    const loaded = await loadConfig(fixture('plain-object.config.ts'))
    expect(loaded.config.environments.dev?.settings.app.name).toBe('Plain')
  })

  test('a relative path is resolved against the given directory', async () => {
    const loaded = await loadConfig('valid.config.ts', join(import.meta.dir, 'fixtures'))
    expect(loaded.path).toBe(fixture('valid.config.ts'))
  })

  test('refuses a literal secret without repeating it', async () => {
    const error = await failure(loadConfig(fixture('literal-secret.config.ts')))
    expect(error.code).toBe('config.invalid')
    expect(error.issues[0]?.path).toBe('environments.dev.providers.google.clientSecret')
    expect(Bun.inspect(error)).not.toContain('literal-secret-value-123')
  })

  test('a file that does not exist is config.not_found', async () => {
    const error = await failure(loadConfig(fixture('missing.config.ts')))
    expect(error.code).toBe('config.not_found')
    expect(error.message).toContain('missing.config.ts')
  })

  test('a file without a default export is config.invalid', async () => {
    const error = await failure(loadConfig(fixture('no-default.config.ts')))
    expect(error.code).toBe('config.invalid')
    expect(error.message).toContain('export default')
  })

  test('a file that throws is config.load_failed, with the file’s own error name only', async () => {
    const error = await failure(loadConfig(fixture('throws.config.ts')))
    expect(error.code).toBe('config.load_failed')
    expect(error.message).toContain('throws.config.ts')
  })
})

describe('the example config', () => {
  test('examples/tula-config/tula.config.ts loads, with every secret a reference', async () => {
    const { config } = await loadConfig(
      join(import.meta.dir, '../../../examples/tula-config/tula.config.ts')
    )
    expect(Object.keys(config.environments)).toEqual(['dev', 'prod'])
    const prod = selectEnvironment(config, 'prod')
    expect(prod.kind).toBe('production')
    expect(prod.settings.mfa.policy).toBe('required')
    expect(requiredSecrets(prod.providers)).toEqual({
      apple: 'APPLE_PRIVATE_KEY',
      discord: 'DISCORD_CLIENT_SECRET',
      facebook: 'FACEBOOK_APP_SECRET',
      github: 'GITHUB_CLIENT_SECRET',
      google: 'GOOGLE_CLIENT_SECRET',
      linkedin: 'LINKEDIN_CLIENT_SECRET',
      microsoft: 'MICROSOFT_CLIENT_SECRET',
      x: 'X_CLIENT_SECRET',
    })
    // The dev entry leaves the password policy to the deployment.
    expect(selectEnvironment(config, 'dev').settings.password).toBeUndefined()
    // One environment declares its webhook endpoints; the other leaves them unmanaged.
    expect(prod.webhooks).toEqual([
      {
        url: 'https://api.northline.app/webhooks/tula',
        eventTypes: ['user.created', 'user.deleted'],
      },
    ])
    expect(selectEnvironment(config, 'dev').webhooks).toBeUndefined()
    // The same for hooks, each entry with the API's defaults filled in.
    expect(prod.hooks).toEqual({
      before_sign_up: {
        url: 'https://api.northline.app/hooks/tula/sign-up',
        enabled: true,
        deadlineMs: 2000,
        failureMode: 'deny',
      },
      before_token: {
        url: 'https://api.northline.app/hooks/tula/claims',
        enabled: true,
        deadlineMs: 1000,
        failureMode: 'deny',
      },
    })
    expect(selectEnvironment(config, 'dev').hooks).toBeUndefined()
  })
})

describe('webhooks', () => {
  const HOOK = 'https://hooks.northline.app/tula'

  function webhooksOf(input: TulaConfigInput) {
    return defineConfig(input).environments.dev?.webhooks
  }

  test('an environment without the key does not manage webhooks: the key stays absent', () => {
    const dev = defineConfig({ environments: { dev: {} } }).environments.dev
    expect(dev && Object.hasOwn(dev, 'webhooks')).toBe(false)
    expect(webhooksOf({ environments: { dev: { webhooks: [] } } })).toEqual([])
  })

  test('event types are a set: sorted, each once; enabled stays absent when left out', () => {
    expect(
      webhooksOf({
        environments: {
          dev: {
            webhooks: [
              { url: HOOK, eventTypes: ['user.deleted', 'user.created', 'user.deleted'] },
              { url: `${HOOK}/2`, eventTypes: ['user.created'], enabled: false },
            ],
          },
        },
      })
    ).toEqual([
      { url: HOOK, eventTypes: ['user.created', 'user.deleted'] },
      { url: `${HOOK}/2`, eventTypes: ['user.created'], enabled: false },
    ])
  })

  test('a secret is a type error and a run-time error that does not repeat it', () => {
    const literal = 'whsec_bGl0ZXJhbC1zZWNyZXQtdmFsdWUtMTIz'
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            webhooks: [
              // @ts-expect-error an endpoint has no secret field: the server makes the secret
              { url: HOOK, eventTypes: ['user.created'], secret: literal },
            ],
          },
        },
      })
    )
    expect(error.code).toBe('config.invalid')
    expect(error.issues).toEqual([
      { path: 'environments.dev.webhooks.0.secret', message: 'unknown key' },
    ])
    expect(Bun.inspect(error)).not.toContain(literal)
  })

  test.each([
    ['no event type', { url: HOOK, eventTypes: [] }, 'webhooks.0.eventTypes'],
    [
      'an unknown event type',
      { url: HOOK, eventTypes: ['user.exploded'] },
      'webhooks.0.eventTypes.0',
    ],
    [
      'an address with a space',
      { url: 'https://a.example/x y', eventTypes: ['user.created'] },
      'webhooks.0.url',
    ],
    ['no address', { eventTypes: ['user.created'] }, 'webhooks.0.url'],
    [
      'enabled that is not a boolean',
      { url: HOOK, eventTypes: ['user.created'], enabled: 'yes' },
      'webhooks.0.enabled',
    ],
  ])('refuses %s, by path, without repeating a value', (_, endpoint, path) => {
    const error = refusal(() =>
      defineConfig({ environments: { dev: { webhooks: [endpoint as never] } } })
    )
    expect(error.issues.map((issue) => issue.path)).toEqual([`environments.dev.${path}`])
    expect(error.message).not.toContain('exploded')
    expect(error.message).not.toContain('x y')
  })

  test.each([
    ['a user and a password', 'https://hookuser:hunter2secret@hooks.northline.app/tula'],
    ['a user alone', 'https://hookuser@hooks.northline.app/tula'],
    ['a password alone', 'https://:hunter2secret@hooks.northline.app/tula'],
    ['in capitals and with a port', 'HTTPS://hookuser:hunter2secret@HOOKS.northline.app:8443/'],
  ])('credentials in an address (%s) are refused by position, never repeated (F5)', (_, url) => {
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            webhooks: [
              { url: HOOK, eventTypes: ['user.created'] },
              { url, eventTypes: ['user.created'] },
            ],
          },
        },
      })
    )
    expect(error.issues).toEqual([
      {
        path: 'environments.dev.webhooks.1.url',
        message:
          'must not carry a user name or a password (user:password@host): the server refuses such an address, and an address is printed in plans and logs',
      },
    ])
    expect(Bun.inspect(error)).not.toContain('hookuser')
    expect(Bun.inspect(error)).not.toContain('hunter2secret')
  })

  test('an @ that is not credentials is an ordinary address', () => {
    expect(
      webhooksOf({
        environments: {
          dev: {
            webhooks: [
              {
                url: 'https://hooks.northline.app/u/@team?to=a@b.example',
                eventTypes: ['user.created'],
              },
            ],
          },
        },
      })
    ).toHaveLength(1)
  })

  test('the same address twice is refused, naming both entries and not the address', () => {
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            webhooks: [
              { url: HOOK, eventTypes: ['user.created'] },
              { url: `${HOOK}/other`, eventTypes: ['user.created'] },
              { url: HOOK, eventTypes: ['user.deleted'] },
            ],
          },
        },
      })
    )
    expect(error.issues).toEqual([
      {
        path: 'environments.dev.webhooks.2.url',
        message:
          'the same address as webhooks.0: an endpoint is identified by its address, so each is listed once',
      },
    ])
    expect(error.message).not.toContain('hooks.northline.app')
  })

  test('more endpoints than an environment may have are refused', () => {
    const webhooks = Array.from({ length: 11 }, (_, index) => ({
      url: `${HOOK}/${index}`,
      eventTypes: ['user.created' as const],
    }))
    const error = refusal(() => defineConfig({ environments: { dev: { webhooks } } }))
    expect(error.issues).toEqual([
      {
        path: 'environments.dev.webhooks',
        message: 'an environment has at most 10 webhook endpoints',
      },
    ])
  })

  test('the fingerprint ignores the order and repeats of event types, and an absent key', async () => {
    const hash = async (input: TulaConfigInput) => {
      const dev = defineConfig(input).environments.dev
      if (!dev) {
        throw new Error('fixture')
      }
      return hashEnvironmentConfig(dev)
    }
    const one = await hash({
      environments: {
        dev: { webhooks: [{ url: HOOK, eventTypes: ['user.created', 'user.deleted'] }] },
      },
    })
    const reordered = await hash({
      environments: {
        dev: {
          webhooks: [{ url: HOOK, eventTypes: ['user.deleted', 'user.created', 'user.created'] }],
        },
      },
    })
    expect(reordered).toBe(one)
    // What an empty entry hashed to before webhooks existed: an absent key adds nothing, so
    // no environment already applied shows a new version of its file.
    const unmanaged = await hash({ environments: { dev: {} } })
    expect(unmanaged).toBe(
      'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    )
    expect(await hash({ environments: { dev: { webhooks: [] } } })).not.toBe(unmanaged)
  })
})

describe('JWT templates', () => {
  const hash = async (settings: EnvironmentSettingsConfig) => {
    const dev = defineConfig({ environments: { dev: { settings } } }).environments.dev
    if (!dev) {
      throw new Error('fixture')
    }
    return hashEnvironmentConfig(dev)
  }

  test('are written in the settings, through the contract’s own schema', () => {
    const config = defineConfig({
      environments: {
        dev: {
          settings: {
            sessions: {
              jwtTemplates: {
                app: { claims: { role: { value: 'member' }, email: { from: 'user.email' } } },
              },
              profiles: { web: { jwtTemplate: 'app' } },
            },
          },
        },
      },
    })
    const sessions = config.environments.dev?.settings.sessions
    expect(sessions?.jwtTemplates.app?.claims.role).toEqual({ value: 'member' })
    expect(sessions?.profiles.web.jwtTemplate).toBe('app')
    expect(sessions?.profiles.mobile.jwtTemplate).toBeNull()
  })

  test.each<[string, EnvironmentSettingsConfig]>([
    [
      'a reserved key',
      { sessions: { jwtTemplates: { app: { claims: { sub: { value: 'x' } } } } } },
    ],
    [
      'a profile naming a missing template',
      { sessions: { profiles: { web: { jwtTemplate: 'gone' } } } },
    ],
    [
      'a source outside the list',
      { sessions: { jwtTemplates: { app: { claims: { ip: { from: 'session.ip' as never } } } } } },
    ],
  ])('refuses %s', (_label, settings) => {
    let thrown: unknown
    try {
      defineConfig({ environments: { dev: { settings } } })
    } catch (error) {
      thrown = error
    }
    expect(isConfigError(thrown)).toBe(true)
  })

  // The fingerprint is what says "this file is what is applied". An environment that uses no
  // template must keep the fingerprint it had before templates could be written, or every
  // applied environment would show a new version of its file after an upgrade.
  test('an environment without templates hashes as it did before they existed', async () => {
    expect(await hash({})).toBe(
      'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    )
    expect(await hash({ sessions: { jwtTemplates: {} } })).toBe(await hash({}))
    expect(await hash({ sessions: { profiles: { web: { jwtTemplate: null } } } })).toBe(
      await hash({})
    )
  })

  // As for templates: `sms` arrived with a default in every document (ADR 0037).
  test('an environment that leaves text messages alone hashes as it did before they existed', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    expect(await hash({})).toBe(before)
    expect(await hash({ sms: { enabled: false, allowedCountries: [] } })).toBe(before)
    expect(await hash({ sms: {} })).toBe(before)
  })

  // The texted sign-in code arrived later still, off in every document (ADR 0037).
  test('the texted sign-in code is in the fingerprint only when it is on', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    const methods = (smsCode: boolean) => ({
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: false },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: smsCode },
        },
      },
    })
    expect(await hash(methods(false))).toBe(before)
    expect(await hash(methods(true))).not.toBe(before)
  })

  // A texted code as the second step arrived after `mfa.policy` did.
  test('a texted code as the second step is in the fingerprint only when it is on', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    expect(await hash({})).toBe(before)
    expect(await hash({ mfa: { policy: 'optional' } })).toBe(before)
    expect(await hash({ mfa: { smsCode: { enabled: false } } })).toBe(before)
    const on = await hash({ mfa: { smsCode: { enabled: true } } })
    expect(on).not.toBe(before)
    // The policy still counts beside it.
    expect(await hash({ mfa: { policy: 'required', smsCode: { enabled: true } } })).not.toBe(on)
    expect(await hash({ mfa: { policy: 'required' } })).not.toBe(before)
  })

  // The device-binding option arrived after profiles did (ADR 0043): a profile that leaves it
  // at what it did before hashes the same, written out or not.
  test('a profile’s device binding is in the fingerprint only when it is not the default', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    const profiles = (value: NonNullable<EnvironmentSettingsConfig['sessions']>['profiles']) =>
      hash({ sessions: { profiles: value } })
    expect(await hash({})).toBe(before)
    expect(await profiles({ web: { deviceBinding: 'none' } })).toBe(before)
    expect(await profiles({ mobile: { deviceBinding: 'optional' } })).toBe(before)
    const required = await profiles({ mobile: { deviceBinding: 'required' } })
    const none = await profiles({ mobile: { deviceBinding: 'none' } })
    // `optional` is not the web profile's default: written there, it counts.
    const web = await profiles({ web: { deviceBinding: 'optional' } })
    expect(new Set([before, required, none, web]).size).toBe(4)
    // A profile an environment added: `optional` is its default.
    const kiosk = await profiles({ kiosk: {} })
    expect(await profiles({ kiosk: { deviceBinding: 'optional' } })).toBe(kiosk)
    expect(await profiles({ kiosk: { deviceBinding: 'none' } })).not.toBe(kiosk)
  })

  test('the option is validated by the contract: an unknown value is refused, by its path', () => {
    const config = (value: unknown) =>
      defineConfig({
        environments: {
          dev: { settings: { sessions: { profiles: { mobile: { deviceBinding: value } } } } },
        },
      } as never)
    expect(
      config('required').environments.dev?.settings.sessions.profiles.mobile.deviceBinding
    ).toBe('required')
    for (const value of ['enforced', 'Required', true]) {
      const error = refusal(() => config(value))
      expect(JSON.stringify(error.issues)).toContain('sessions.profiles.mobile.deviceBinding')
      // Never a value from the file.
      expect(JSON.stringify(error.issues)).not.toContain('enforced')
      expect(error.message).not.toContain('enforced')
    }
  })

  test('switching text messages on, and each country, changes the fingerprint', async () => {
    const off = await hash({})
    const onNowhere = await hash({ sms: { enabled: true } })
    const listed = await hash({ sms: { allowedCountries: ['US'] } })
    const on = await hash({ sms: { enabled: true, allowedCountries: ['US'] } })
    const wider = await hash({ sms: { enabled: true, allowedCountries: ['US', 'DE'] } })
    expect(new Set([off, onNowhere, listed, on, wider]).size).toBe(5)
  })

  // The daily limit arrived after `sms` did: a file that was applied before it hashes the same.
  test('the default daily limit of text messages is not in the fingerprint, and another one is', async () => {
    const on = 'sha256:ae16222002d43eb0136cda78b385d1cab17cc2009383854afcac4b7a13f766d9'
    expect(await hash({ sms: { enabled: true, allowedCountries: ['US'] } })).toBe(on)
    expect(
      await hash({ sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 } })
    ).toBe(on)
    const lower = await hash({
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 100 },
    })
    expect(lower).not.toBe(on)
    expect(await hash({ sms: { dailyMessageLimit: 500 } })).toBe(await hash({}))
    expect(await hash({ sms: { dailyMessageLimit: 100 } })).not.toBe(await hash({}))
  })

  test('a daily limit that is not a whole number of at least one is refused', () => {
    for (const dailyMessageLimit of [0, -1, 1.5, 1_000_001, null]) {
      let thrown: unknown
      try {
        defineConfig({
          environments: { dev: { settings: { sms: { dailyMessageLimit } } } },
        } as never)
      } catch (error) {
        thrown = error
      }
      expect(isConfigError(thrown)).toBe(true)
      expect(String((thrown as Error).message)).toContain(
        'environments.dev.settings.sms.dailyMessageLimit'
      )
    }
  })

  test('a country that is not one is refused, named by its place', () => {
    for (const allowedCountries of [['us'], ['USA'], ['ZZ'], ['US', 'US']]) {
      let thrown: unknown
      try {
        defineConfig({ environments: { dev: { settings: { sms: { allowedCountries } } } } })
      } catch (error) {
        thrown = error
      }
      expect(isConfigError(thrown)).toBe(true)
      expect(String((thrown as Error).message)).toContain('environments.dev.settings.sms')
    }
  })

  test('a template, a claim and a profile’s use of one all change the fingerprint', async () => {
    const template = { app: { claims: { role: { value: 'member' } } } }
    const defined = await hash({ sessions: { jwtTemplates: template } })
    const used = await hash({
      sessions: { jwtTemplates: template, profiles: { web: { jwtTemplate: 'app' } } },
    })
    const changed = await hash({
      sessions: { jwtTemplates: { app: { claims: { role: { value: 'owner' } } } } },
    })
    expect(new Set([await hash({}), defined, used, changed]).size).toBe(4)
  })

  test('the order claims and templates are written in does not', async () => {
    const one = await hash({
      sessions: {
        jwtTemplates: {
          a: { claims: { x: { value: 1 }, y: { from: 'user.email' } } },
          b: { claims: {} },
        },
      },
    })
    const other = await hash({
      sessions: {
        jwtTemplates: {
          b: { claims: {} },
          a: { claims: { y: { from: 'user.email' }, x: { value: 1 } } },
        },
      },
    })
    expect(other).toBe(one)
  })
})

describe('hooks', () => {
  const ASK = 'https://api.northline.app/hooks/tula'

  function hooksOf(input: TulaConfigInput) {
    return defineConfig(input).environments.dev?.hooks
  }

  test('an environment without the key does not manage hooks: the key stays absent', () => {
    const dev = defineConfig({ environments: { dev: {} } }).environments.dev
    expect(dev && Object.hasOwn(dev, 'hooks')).toBe(false)
    expect(hooksOf({ environments: { dev: { hooks: {} } } })).toEqual({})
  })

  test('a hook is keyed by its point; what is left out takes the API’s defaults', () => {
    expect(
      hooksOf({
        environments: {
          dev: {
            hooks: {
              before_sign_up: { url: ASK },
              before_token: {
                url: `${ASK}/claims`,
                deadlineMs: 500,
                failureMode: 'allow',
                enabled: false,
              },
            },
          },
        },
      })
    ).toEqual({
      // The contract's defaults (`CreateHookRequestSchema`): on, two seconds, refuse on failure.
      before_sign_up: { url: ASK, enabled: true, deadlineMs: 2000, failureMode: 'deny' },
      before_token: {
        url: `${ASK}/claims`,
        enabled: false,
        deadlineMs: 500,
        failureMode: 'allow',
      },
    })
  })

  test('a secret is a type error and a run-time error that does not repeat it', () => {
    const literal = 'whsec_bGl0ZXJhbC1ob29rLXNlY3JldC12YWx1ZTEyMw'
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: {
            hooks: {
              // @ts-expect-error a hook has no secret field: the server makes the secret
              before_sign_up: { url: ASK, secret: literal },
            },
          },
        },
      })
    )
    expect(error.code).toBe('config.invalid')
    expect(error.issues).toEqual([
      { path: 'environments.dev.hooks.before_sign_up.secret', message: 'unknown key' },
    ])
    expect(Bun.inspect(error)).not.toContain(literal)
  })

  test.each([
    ['a point the contract does not define', { before_refresh: { url: ASK } }, 'before_refresh'],
    ['no address', { before_session: {} }, 'before_session.url'],
    [
      'an address with a space',
      { before_session: { url: 'https://a.example/x y' } },
      'before_session.url',
    ],
    [
      'a deadline under the least',
      { before_sign_up: { url: ASK, deadlineMs: 99 } },
      'before_sign_up.deadlineMs',
    ],
    [
      'a deadline over the most',
      { before_sign_up: { url: ASK, deadlineMs: 5001 } },
      'before_sign_up.deadlineMs',
    ],
    [
      'a failure mode that is neither',
      { before_token: { url: ASK, failureMode: 'open' } },
      'before_token.failureMode',
    ],
    [
      'enabled that is not a boolean',
      { before_token: { url: ASK, enabled: 'yes' } },
      'before_token.enabled',
    ],
    ['a list in place of the points', [{ point: 'before_sign_up', url: ASK }], ''],
  ])('refuses %s, by path, without repeating a value', (_, hooks, path) => {
    const error = refusal(() => defineConfig({ environments: { dev: { hooks: hooks as never } } }))
    expect(error.issues.map((issue) => issue.path)).toEqual([
      path === '' ? 'environments.dev.hooks' : `environments.dev.hooks.${path}`,
    ])
    expect(error.message).not.toContain('x y')
    expect(error.message).not.toContain('open')
  })

  test.each([
    ['a user and a password', 'https://hookuser:hunter2secret@api.northline.app/hooks'],
    ['a user alone', 'https://hookuser@api.northline.app/hooks'],
    ['a password alone', 'https://:hunter2secret@api.northline.app/hooks'],
  ])('credentials in an address (%s) are refused by position, never repeated', (_, url) => {
    const error = refusal(() =>
      defineConfig({
        environments: { dev: { hooks: { before_sign_up: { url: ASK }, before_session: { url } } } },
      })
    )
    expect(error.issues).toEqual([
      {
        path: 'environments.dev.hooks.before_session.url',
        message:
          'must not carry a user name or a password (user:password@host): the server refuses such an address, and an address is printed in plans and logs',
      },
    ])
    expect(Bun.inspect(error)).not.toContain('hookuser')
    expect(Bun.inspect(error)).not.toContain('hunter2secret')
  })

  test('the fingerprint covers every field of a hook, and an absent key adds nothing', async () => {
    const hash = async (input: TulaConfigInput) => {
      const dev = defineConfig(input).environments.dev
      if (!dev) {
        throw new Error('fixture')
      }
      return hashEnvironmentConfig(dev)
    }
    const one = await hash({ environments: { dev: { hooks: { before_sign_up: { url: ASK } } } } })
    // A default written out is the same file.
    expect(
      await hash({
        environments: {
          dev: {
            hooks: {
              before_sign_up: { failureMode: 'deny', deadlineMs: 2000, enabled: true, url: ASK },
            },
          },
        },
      })
    ).toBe(one)
    for (const other of [
      { url: `${ASK}/2` },
      { url: ASK, failureMode: 'allow' as const },
      { url: ASK, deadlineMs: 2001 },
      { url: ASK, enabled: false },
    ]) {
      expect(await hash({ environments: { dev: { hooks: { before_sign_up: other } } } })).not.toBe(
        one
      )
    }
    expect(
      await hash({ environments: { dev: { hooks: { before_session: { url: ASK } } } } })
    ).not.toBe(one)
    // What an empty entry hashed to before hooks could be written: the value the webhooks'
    // test pins. No environment already applied shows a new version of its file.
    const unmanaged = await hash({ environments: { dev: {} } })
    expect(unmanaged).toBe(
      'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    )
    expect(await hash({ environments: { dev: { hooks: {} } } })).not.toBe(unmanaged)
  })
})

describe('native apps', () => {
  const FP_A = Array.from({ length: 32 }, () => 'AA').join(':')
  const FP_B = Array.from({ length: 32 }, () => 'BB').join(':')
  const ios = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'app.northline.ios' } as const
  const android: AndroidAppConfig = {
    platform: 'android',
    packageName: 'app.northline.android',
    sha256CertFingerprints: [FP_A],
  }

  function appsOf(input: TulaConfigInput) {
    return defineConfig(input).environments.dev?.nativeApps
  }

  const hash = async (input: TulaConfigInput) => {
    const dev = defineConfig(input).environments.dev
    if (!dev) {
      throw new Error('fixture')
    }
    return hashEnvironmentConfig(dev)
  }

  test('an environment without the key does not manage native apps: the key stays absent', () => {
    const dev = defineConfig({ environments: { dev: {} } }).environments.dev
    expect(dev && Object.hasOwn(dev, 'nativeApps')).toBe(false)
    expect(appsOf({ environments: { dev: { nativeApps: [] } } })).toEqual([])
  })

  test('fingerprints are a set in the stored form: case, colons, order and repeats go', () => {
    expect(
      appsOf({
        environments: {
          dev: {
            nativeApps: [
              ios,
              {
                ...android,
                sha256CertFingerprints: [FP_B, 'aa'.repeat(32), FP_B.toLowerCase(), FP_A],
              },
            ],
          },
        },
      })
    ).toEqual([ios, { ...android, sha256CertFingerprints: [FP_A, FP_B] }])
  })

  test.each<[string, unknown, string]>([
    ['a team id in lower case', { ...ios, teamId: 'a1b2c3d4e5' }, 'nativeApps.0.teamId'],
    ['a bundle id of one segment', { ...ios, bundleId: 'northline' }, 'nativeApps.0.bundleId'],
    [
      'a bundle id with a wildcard',
      { ...ios, bundleId: 'app.northline.*' },
      'nativeApps.0.bundleId',
    ],
    [
      'a package name whose segment starts with a digit',
      { ...android, packageName: 'app.1northline' },
      'nativeApps.0.packageName',
    ],
    [
      'a fingerprint that is not 32 bytes',
      { ...android, sha256CertFingerprints: ['AA:BB'] },
      'nativeApps.0.sha256CertFingerprints.0',
    ],
    [
      'no fingerprint',
      { ...android, sha256CertFingerprints: [] },
      'nativeApps.0.sha256CertFingerprints',
    ],
    [
      'an iOS app with fingerprints',
      { ...ios, sha256CertFingerprints: [FP_A] },
      'nativeApps.0.sha256CertFingerprints',
    ],
    ['an Android app with a team', { ...android, teamId: 'A1B2C3D4E5' }, 'nativeApps.0.teamId'],
    [
      'a relation of its own',
      { ...android, relation: ['delegate_permission/common.handle_all_urls'] },
      'nativeApps.0.relation',
    ],
    ['a platform that is not one', { ...ios, platform: 'windows' }, 'nativeApps.0.platform'],
  ])('refuses %s', (_label, app, path) => {
    const error = refusal(() =>
      defineConfig(untyped({ environments: { dev: { nativeApps: [app] } } }))
    )
    expect(error.issues.map((issue) => issue.path)).toEqual([`environments.dev.${path}`])
  })

  test('more fingerprints than an app may have are refused', () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      Array.from({ length: 32 }, () => index.toString(16).padStart(2, '0')).join(':')
    )
    const error = refusal(() =>
      defineConfig({
        environments: { dev: { nativeApps: [{ ...android, sha256CertFingerprints: many }] } },
      })
    )
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'environments.dev.nativeApps.0.sha256CertFingerprints',
    ])
  })

  test('the same app twice is refused; the same name on the other platform is another app', () => {
    const error = refusal(() =>
      defineConfig({
        environments: {
          dev: { nativeApps: [ios, android, { ...ios, teamId: 'ZZZZZZZZZZ' }] },
        },
      })
    )
    expect(error.issues).toEqual([
      {
        path: 'environments.dev.nativeApps.2.bundleId',
        message:
          'the same app as nativeApps.0: an app is identified by its platform and its bundle id, so each is listed once',
      },
    ])
    expect(
      appsOf({
        environments: {
          dev: {
            nativeApps: [
              { ...ios, bundleId: 'app.northline' },
              { ...android, packageName: 'app.northline' },
            ],
          },
        },
      })
    ).toHaveLength(2)
  })

  test('more apps than an environment may have are refused', () => {
    const nativeApps = Array.from({ length: 21 }, (_, index) => ({
      ...ios,
      bundleId: `app.northline.n${index}`,
    }))
    const error = refusal(() => defineConfig({ environments: { dev: { nativeApps } } }))
    expect(error.issues).toEqual([
      { path: 'environments.dev.nativeApps', message: 'an environment has at most 20 native apps' },
    ])
  })

  test('the fingerprint ignores how fingerprints are written, and an absent key', async () => {
    const one = await hash({
      environments: { dev: { nativeApps: [{ ...android, sha256CertFingerprints: [FP_A, FP_B] }] } },
    })
    expect(
      await hash({
        environments: {
          dev: {
            nativeApps: [
              { ...android, sha256CertFingerprints: ['bb'.repeat(32), FP_A.toLowerCase(), FP_B] },
            ],
          },
        },
      })
    ).toBe(one)
    expect(await hash({ environments: { dev: { nativeApps: [android] } } })).not.toBe(one)
    // What an empty entry hashed to before native apps could be written: the value the
    // webhooks' test pins. No environment already applied shows a new version of its file.
    const unmanaged = await hash({ environments: { dev: {} } })
    expect(unmanaged).toBe(
      'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    )
    expect(await hash({ environments: { dev: { nativeApps: [] } } })).not.toBe(unmanaged)
  })
})

describe('email templates', () => {
  const hash = async (settings: EnvironmentSettingsConfig) => {
    const dev = defineConfig({ environments: { dev: { settings } } }).environments.dev
    if (!dev) {
      throw new Error('fixture')
    }
    return hashEnvironmentConfig(dev)
  }
  const verify = (subject: string) => ({
    emails: { templates: { email_verification: { subject, body: 'Your code: {{code}}' } } },
  })

  test('a template is read from the file as written', () => {
    const dev = defineConfig({
      environments: { dev: { settings: verify('{{code}} is your code') } },
    }).environments.dev
    expect(dev?.settings.emails.templates).toEqual({
      email_verification: { subject: '{{code}} is your code', body: 'Your code: {{code}}' },
    })
  })

  test.each<[string, unknown]>([
    ['a code message without its code', { email_verification: { body: 'Welcome.' } }],
    ['a notice with a code', { password_changed: { body: 'Enter {{code}}.' } }],
    ['a notice with a link', { password_changed: { body: 'See https://example.com/x' } }],
    ['a kind that does not exist', { welcome: { body: 'Hello.' } }],
    ['a placeholder that does not exist', { email_verification: { body: '{{code}} {{name}}' } }],
  ])('refused when the file is loaded: %s', (_name, templates) => {
    let thrown: unknown
    try {
      defineConfig({ environments: { dev: { settings: { emails: { templates } } as never } } })
    } catch (error) {
      thrown = error
    }
    expect(isConfigError(thrown)).toBe(true)
  })

  // As for JWT templates and `sms`: `emails` arrived with a default in every document
  // (ADR 0039), and an environment that words nothing keeps the fingerprint it had.
  test('an environment without email templates hashes as it did before they existed', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    expect(await hash({})).toBe(before)
    expect(await hash({ emails: {} })).toBe(before)
    expect(await hash({ emails: { templates: {} } })).toBe(before)
  })

  test('a template, and each change to one, changes the fingerprint', async () => {
    const none = await hash({})
    const one = await hash(verify('{{code}} is your code'))
    const other = await hash(verify('Code {{code}}'))
    expect(new Set([none, one, other]).size).toBe(3)
  })
})

describe('text message templates', () => {
  const hash = async (settings: EnvironmentSettingsConfig) => {
    const dev = defineConfig({ environments: { dev: { settings } } }).environments.dev
    if (!dev) {
      throw new Error('fixture')
    }
    return hashEnvironmentConfig(dev)
  }
  const signIn = (text: string) => ({ sms: { templates: { sign_in: { text } } } })

  test('a template is read from the file as written', () => {
    const dev = defineConfig({
      environments: { dev: { settings: signIn('Use {{code}} to sign in.') } },
    }).environments.dev
    expect(dev?.settings.sms.templates).toEqual({ sign_in: { text: 'Use {{code}} to sign in.' } })
  })

  test.each<[string, unknown]>([
    ['a template without its code', { sign_in: { text: 'Welcome.' } }],
    ['a second code line', { sign_in: { text: 'Code {{code}} @evil.example #x' } }],
    ['a link', { sign_in: { text: 'Code {{code}}. See https://example.com/x' } }],
    ['a kind that does not exist', { welcome: { text: 'Code {{code}}' } }],
    ['a placeholder that does not exist', { sign_in: { text: 'Code {{code}} {{name}}' } }],
    ['a field for the last line', { sign_in: { text: 'Code {{code}}', lastLine: '@x #1' } }],
  ])('refused when the file is loaded: %s', (_name, templates) => {
    let thrown: unknown
    try {
      defineConfig({ environments: { dev: { settings: { sms: { templates } } as never } } })
    } catch (error) {
      thrown = error
    }
    expect(isConfigError(thrown)).toBe(true)
  })

  // As for `sms.dailyMessageLimit`: the templates arrived with a default in every document
  // (ADR 0042), and an environment that words nothing keeps the fingerprint it had.
  test('an environment without text message templates hashes as it did before they existed', async () => {
    const before = 'sha256:06efab455d94f577b0fd2648dfd07f2fd51743799595001ee73bc0b0bf3918ad'
    expect(await hash({})).toBe(before)
    expect(await hash({ sms: {} })).toBe(before)
    expect(await hash({ sms: { templates: {} } })).toBe(before)
    // And an environment that texts, with no wording of its own, as it did before too.
    const texting = { sms: { enabled: true, allowedCountries: ['DE'] } }
    expect(await hash({ sms: { ...texting.sms, templates: {} } })).toBe(await hash(texting))
    expect(await hash(texting)).not.toBe(before)
  })

  test('a template, and each change to one, changes the fingerprint', async () => {
    const none = await hash({})
    const one = await hash(signIn('Use {{code}} to sign in.'))
    const other = await hash(signIn('Code: {{code}}'))
    expect(new Set([none, one, other]).size).toBe(3)
  })
})
