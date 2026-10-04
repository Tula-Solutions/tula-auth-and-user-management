import { describe, expect, spyOn, test } from 'bun:test'
import { appOrigin, resolveConfig } from './config'
import { safeRedirectPath } from './paths'

describe('safeRedirectPath', () => {
  test.each([
    ['/dashboard', '/dashboard'],
    ['/dashboard?tab=1#top', '/dashboard?tab=1#top'],
    ['/a/../b', '/b'],
    ['/', '/'],
    ['/path?next=https://evil.example', '/path?next=https://evil.example'],
  ])('%s stays on this origin', (value, expected) => {
    expect(safeRedirectPath(value)).toBe(expected)
  })

  const refused: unknown[] = [
    'https://evil.example',
    'http://evil.example/dashboard',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\tevil',
    '/\t/evil.example',
    '/a\nb',
    'javascript:alert(1)',
    'data:text/html,x',
    'dashboard',
    '',
    ' /dashboard',
    `/${'a'.repeat(3000)}`,
    undefined,
    null,
    42,
    ['/dashboard'],
  ]
  test.each(refused.map((value) => ({ value })))('$value is refused', ({ value }) => {
    expect(safeRedirectPath(value)).toBe('/')
    expect(safeRedirectPath(value, '/home')).toBe('/home')
  })
})

describe('configuration', () => {
  const base = { apiUrl: 'http://api:3003/', publishableKey: 'tula_pk_dev_x', environmentId: 'e1' }

  test('defaults come from the API URL and the environment id', () => {
    const config = resolveConfig(base)
    expect(config.apiUrl).toBe('http://api:3003')
    expect(config.issuer).toBe('http://api:3003/v1/environments/e1')
    expect(config.jwksUrl).toBe('http://api:3003/v1/environments/e1/.well-known/jwks.json')
    expect(config.path).toBe('/api/tula')
    expect(config.secretKey).toBeNull()
    expect(config.timeoutMs).toBe(15_000)
  })

  test('a public issuer changes what iss must be, not where keys are fetched', () => {
    const config = resolveConfig({
      ...base,
      issuer: 'https://auth.example.com/v1/environments/e1/',
    })
    expect(config.issuer).toBe('https://auth.example.com/v1/environments/e1')
    expect(config.jwksUrl).toBe('http://api:3003/v1/environments/e1/.well-known/jwks.json')
  })

  test.each([
    ['no API URL', { ...base, apiUrl: undefined }],
    ['a relative API URL', { ...base, apiUrl: '/api' }],
    ['an API URL that is not http', { ...base, apiUrl: 'ftp://api' }],
    ['no publishable key', { ...base, publishableKey: undefined }],
    ['a secret key as the publishable key', { ...base, publishableKey: 'tula_sk_dev_x' }],
    ['no environment id', { ...base, environmentId: undefined }],
    ['a publishable key as the secret key', { ...base, secretKey: 'tula_pk_dev_x' }],
    ['an app URL that is not a URL', { ...base, appUrl: 'app.example.com' }],
    ['a handler path with a query', { ...base, path: '/api/tula?x=1' }],
    ['an empty handler path', { ...base, path: '/' }],
  ])('%s is a TypeError', (_name, options) => {
    expect(() => resolveConfig(options)).toThrow(TypeError)
  })

  test('what is left out is read from the environment, and an option wins over it', () => {
    const names = ['TULA_API_URL', 'NEXT_PUBLIC_TULA_PUBLISHABLE_KEY', 'TULA_ENVIRONMENT_ID']
    const before = names.map((name) => process.env[name])
    process.env.TULA_API_URL = 'http://from-env:3003'
    process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY = 'tula_pk_dev_env'
    process.env.TULA_ENVIRONMENT_ID = 'env-from-env'
    try {
      expect(resolveConfig()).toMatchObject({
        apiUrl: 'http://from-env:3003',
        publishableKey: 'tula_pk_dev_env',
        environmentId: 'env-from-env',
      })
      expect(resolveConfig({ environmentId: 'explicit' }).environmentId).toBe('explicit')
    } finally {
      names.forEach((name, index) => {
        const value = before[index]
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      })
    }
  })

  /** Run with environment variables set, and put them back. */
  function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
    const before = Object.keys(values).map((name) => [name, process.env[name]] as const)
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    try {
      return run()
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  }

  const forwarded = new Request('http://localhost:3000/x', {
    headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.1' },
  })

  test('the trusted proxy hops are read from the environment, and an option wins over it', () => {
    withEnv({ TULA_TRUSTED_PROXY_HOPS: '2' }, () => {
      expect(resolveConfig(base).clientIp(forwarded)).toBe('198.51.100.7')
      expect(resolveConfig({ ...base, trustedProxyHops: 1 }).clientIp(forwarded)).toBe('10.0.0.1')
      expect(resolveConfig({ ...base, trustedProxyHops: 0 }).clientIp(forwarded)).toBeNull()
    })
    withEnv({ TULA_TRUSTED_PROXY_HOPS: undefined }, () => {
      expect(resolveConfig(base).clientIp(forwarded)).toBeNull()
    })
  })

  test.each(['-1', '1.5', 'one', '1 '])('TULA_TRUSTED_PROXY_HOPS=%p is a TypeError', (value) => {
    withEnv({ TULA_TRUSTED_PROXY_HOPS: value }, () => {
      expect(() => resolveConfig(base)).toThrow(TypeError)
    })
  })

  test('in production, forwarding no visitor address is said once per process', () => {
    const warnings: string[] = []
    const onWarning = (message: string) => warnings.push(message)
    withEnv({ NODE_ENV: 'production', TULA_TRUSTED_PROXY_HOPS: undefined }, () => {
      resolveConfig({ ...base, onWarning })
      resolveConfig({ ...base, onWarning })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('TULA_TRUSTED_PROXY_HOPS')
      expect(warnings[0]).toContain('rate limit')
      // Nothing to say when the app has decided how the address is known.
      resolveConfig({ ...base, trustedProxyHops: 1, onWarning: (m) => warnings.push(m) })
      resolveConfig({ ...base, clientIp: () => null, onWarning: (m) => warnings.push(m) })
      expect(warnings).toHaveLength(1)
    })
    withEnv({ NODE_ENV: 'development', TULA_TRUSTED_PROXY_HOPS: undefined }, () => {
      resolveConfig({ ...base, onWarning: (m) => warnings.push(m) })
      expect(warnings).toHaveLength(1)
    })
  })

  test('without onWarning a warning goes to console.warn', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      resolveConfig(base).warn('test-only-key', 'something is misconfigured')
      resolveConfig(base).warn('test-only-key', 'something is misconfigured')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toBe('@tula/nextjs: something is misconfigured')
    } finally {
      spy.mockRestore()
    }
  })

  test('without a fetch option the global fetch is used, and it is one function for every configuration', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    try {
      const config = resolveConfig(base)
      expect(resolveConfig(base).fetch).toBe(config.fetch)
      const response = await config.fetch(new Request('http://api:3003/v1/status'))
      expect(await response.text()).toBe('ok')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('the app’s origin follows the proxy’s headers unless one is configured', () => {
    const request = new Request('http://10.0.0.5:3000/x', {
      headers: { 'x-forwarded-host': 'app.example.com, inner', 'x-forwarded-proto': 'https' },
    })
    expect(appOrigin(request, { appOrigin: null })).toBe('https://app.example.com')
    expect(appOrigin(request, { appOrigin: 'https://www.example.com' })).toBe(
      'https://www.example.com'
    )
    expect(appOrigin(new Request('http://localhost:3000/x'), { appOrigin: null })).toBe(
      'http://localhost:3000'
    )
    const odd = new Request('http://localhost:3000/x', { headers: { 'x-forwarded-host': 'a b' } })
    expect(appOrigin(odd, { appOrigin: null })).toBe('http://localhost:3000')
  })
})
