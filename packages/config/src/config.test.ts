import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type ConfigError,
  defineConfig,
  env,
  hashEnvironmentConfig,
  isConfigError,
  isSecretRef,
  loadConfig,
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
          },
        },
      },
    })
    const prod = config.environments.prod
    expect(prod?.kind).toBe('production')
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
      { environments: { dev: { providers: { facebook: { clientId: 'x' } } } } },
      'environments.dev.providers.facebook',
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
      github: 'GITHUB_CLIENT_SECRET',
      google: 'GOOGLE_CLIENT_SECRET',
    })
    // The dev entry leaves the password policy to the deployment.
    expect(selectEnvironment(config, 'dev').settings.password).toBeUndefined()
  })
})
