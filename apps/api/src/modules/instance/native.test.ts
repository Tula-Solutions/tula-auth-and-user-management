import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  MAX_NATIVE_APPS,
} from '@tula/contract'
import type { MemoryDiagnostics } from '~/adapters/memory/diagnostics'
import { unconfiguredSmsSender } from '~/adapters/sms/unconfigured'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Native from '~/modules/instance/native'
import * as Instance from '~/modules/instance/service'
import * as Jwks from '~/modules/jwks/service'
import * as NativeApps from '~/modules/native-app/service'
import type { FetchedDocument } from '~/ports/diagnostics'
import type { NativeAppRecord } from '~/ports/native-app-store'
import { createTestDeps, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'
import type { DiagnosticCheck } from './schema'

const PUBLIC_URL = 'https://auth.example.com'
const PUBLIC = { ...TEST_CONFIG, publicUrl: `${PUBLIC_URL}/` }

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')

// What a stored app and an environment's settings hold. None of it may reach an answer.
const TEAM = 'CANARYTEAM'
const BUNDLE = 'com.canary-bundle.app'
const PACKAGE = 'com.canary_package.app'
const RP_ID = 'canary-rp.example'
const NATIVE_IDS = ['native_app_identities', 'native_app_files', 'native_app_passkeys'] as const

const SKIPPED_NONE = 'No native app is registered in any environment.'
const NOT_THE_PLATFORMS =
  'Whether Apple or Android can reach them at the apps’ own domain was not checked: the server never requests that address.'

let sequence = 0

async function setup(overrides: Partial<TestDeps> = {}) {
  const deps = createTestDeps({ config: PUBLIC, ...overrides })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await Jwks.ensureKeys(deps, TEST_TENANT.environmentId)
  const diagnostics = deps.diagnostics as MemoryDiagnostics
  serve(deps)
  return { deps, diagnostics }
}

/** Answer the probe with the app's own public routes: what `PUBLIC_URL` would serve. */
function serve(deps: TestDeps, change: (document: FetchedDocument) => FetchedDocument = (d) => d) {
  const diagnostics = deps.diagnostics as MemoryDiagnostics
  diagnostics.httpDocument = async (url) => {
    diagnostics.requested.push(url)
    const response = await createApp(deps).request(new URL(url).pathname)
    return change({
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: response.status === 200 ? await response.text() : null,
    })
  }
}

/** Store an app as it is given: the memory store checks nothing, like a row written by hand. */
async function store(
  deps: TestDeps,
  app: Partial<NativeAppRecord>,
  environmentId: string = TEST_TENANT.environmentId
): Promise<NativeAppRecord> {
  sequence += 1
  const record: NativeAppRecord = {
    id: `00000000-0000-7000-9000-${String(sequence).padStart(12, '0')}`,
    projectId: TEST_TENANT.projectId,
    environmentId,
    platform: 'ios',
    identifier: BUNDLE,
    teamId: TEAM,
    sha256CertFingerprints: [],
    createdAt: new Date(deps.clock.now().getTime() + sequence),
    updatedAt: deps.clock.now(),
    ...app,
  }
  await deps.nativeApps.insert(record, Audit.none('fixture'))
  return record
}

const ios = (identifier = BUNDLE): Partial<NativeAppRecord> => ({ identifier })
const android = (identifier = PACKAGE, fingerprints = [AA, BB]): Partial<NativeAppRecord> => ({
  platform: 'android',
  identifier,
  teamId: null,
  sha256CertFingerprints: fingerprints,
})

/**
 * Seed an environment's passkey settings. The relying party's own origin is among the allowed
 * origins unless `more` says otherwise: it is what an iOS app presents (ADR 0027), and an
 * environment that leaves it out is a finding of its own, tested where it is meant.
 */
function passkeys(
  deps: TestDeps,
  enabled: boolean,
  rpId: string | null,
  environmentId: string = TEST_TENANT.environmentId,
  more: Partial<EnvironmentSettings> = {}
) {
  const methods = DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.signIn,
        methods: { ...methods, passkey: { ...methods.passkey, enabled } },
      },
      passkeys: { rpId },
      urls: origins(rpId === null ? [] : [`https://${rpId}`]),
      ...more,
    },
  })
}

const origins = (allowedOrigins: string[]): EnvironmentSettings['urls'] => ({
  ...DEFAULT_ENVIRONMENT_SETTINGS.urls,
  allowedOrigins,
})

function addEnvironments(deps: TestDeps, count: number): string[] {
  const ids: string[] = []
  for (let index = 1; index <= count; index += 1) {
    const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`
    ids.push(id)
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: new Date(deps.clock.now().getTime() + index),
    })
  }
  return ids
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const check = checks.find((candidate) => candidate.id === id)
  if (!check) {
    throw new Error(`no check ${id}`)
  }
  return check
}

async function native(deps: Parameters<typeof Instance.diagnostics>[0], timeoutMs?: number) {
  const { checks } = await Instance.diagnostics(deps, timeoutMs)
  return {
    identities: byId(checks, 'native_app_identities'),
    files: byId(checks, 'native_app_files'),
    passkeys: byId(checks, 'native_app_passkeys'),
  }
}

/** Nothing an app, a setting or an environment is known by is in the text. */
function expectNothingNamed(value: unknown, deps: TestDeps) {
  const text = JSON.stringify(value).replaceAll(JSON.stringify(deps.config.publicUrl), '""')
  for (const secret of [TEAM, BUNDLE, PACKAGE, RP_ID, AA, BB, 'CANARY', 'canary']) {
    expect(text).not.toContain(secret)
  }
  expect(text).not.toContain(TEST_TENANT.environmentId)
  expect(text).not.toMatch(/00000000-0000-7000-[89]000-\d{12}/)
}

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

/** Every line the checks log, as text. */
function logged(): () => string {
  const lines: unknown[] = []
  for (const level of ['info', 'warn', 'error'] as const) {
    spies.push(
      spyOn(logger, level).mockImplementation((message, context) => {
        lines.push([message, context])
      })
    )
  }
  return () => JSON.stringify(lines)
}

describe('no native app', () => {
  test('in any environment: the three checks are skipped, and nothing is read or fetched for them', async () => {
    const { deps, diagnostics } = await setup()
    let settingsRead = 0
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    deps.environmentSettings.get = async (...args) => {
      settingsRead += 1
      return get(...args)
    }
    const result = await Instance.diagnostics(deps)
    for (const id of NATIVE_IDS) {
      expect(byId(result.checks, id)).toEqual({ id, status: 'skipped', summary: SKIPPED_NONE })
    }
    expect(result.checks.map((check) => check.id).slice(-3)).toEqual([...NATIVE_IDS])
    expect(settingsRead).toBe(0)
    expect(diagnostics.requested).toEqual([`${PUBLIC_URL}/v1/status`])
  })
})

describe('a healthy environment', () => {
  test('both platforms: every check is ok, with what was looked at and what was not', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    await store(deps, android())
    passkeys(deps, true, RP_ID)
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_identities')).toEqual({
      id: 'native_app_identities',
      status: 'ok',
      summary:
        'The 2 native apps registered in 1 environment are well formed: each passes the rules a registration is held to. Whether a bundle ID, a team or a fingerprint is the one your app really has cannot be checked from here.',
    })
    expect(byId(result.checks, 'native_app_files')).toEqual({
      id: 'native_app_files',
      status: 'ok',
      summary: `The association files the server builds name exactly the registered native apps (in 1 environment). 2 of them, fetched at PUBLIC_URL, the server’s own address, came back as built: HTTP 200, \`application/json\`, no redirect. These are the server’s own copies. ${NOT_THE_PLATFORMS}`,
    })
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'ok',
      summary:
        'Passkeys are on in 1 environment with native apps, with a relying party a platform can associate with an app. Whether that domain serves the files was not checked: the server never requests it.',
    })
    const base = `${PUBLIC_URL}/v1/environments/${TEST_TENANT.environmentId}/.well-known`
    expect(diagnostics.requested.sort()).toEqual(
      [
        `${PUBLIC_URL}/v1/status`,
        `${base}/apple-app-site-association`,
        `${base}/assetlinks.json`,
      ].sort()
    )
    expectNothingNamed(result, deps)
  })

  test('apps of one platform only: the other platform’s file is not asked for and is no failure', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, android())
    passkeys(deps, true, RP_ID)
    const found = await native(deps)
    expect(found.identities.status).toBe('ok')
    expect(found.identities.summary).toStartWith('The 1 native app registered in 1 environment is ')
    expect(found.files.status).toBe('ok')
    expect(found.files.summary).toContain(
      'One of them, fetched at PUBLIC_URL, the server’s own address, came back as built'
    )
    expect(found.passkeys.status).toBe('ok')
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toEqual([
      `${PUBLIC_URL}/v1/environments/${TEST_TENANT.environmentId}/.well-known/assetlinks.json`,
    ])
  })

  test('a loopback PUBLIC_URL: the files are compared in process and not fetched, and it says so', async () => {
    const { deps, diagnostics } = await setup({ config: TEST_CONFIG })
    await store(deps, ios())
    passkeys(deps, true, RP_ID)
    const found = await native(deps)
    expect(found.files).toEqual({
      id: 'native_app_files',
      status: 'ok',
      summary: `The association files the server builds name exactly the registered native apps (in 1 environment). They were not fetched: PUBLIC_URL, the server’s own address, is a loopback address, which the server cannot check from where it runs. ${NOT_THE_PLATFORMS}`,
    })
    expect(diagnostics.requested).toEqual([])
  })

  test('only PUBLIC_URL is ever requested: never the relying party, an allowed origin or a redirect URL', async () => {
    const { deps, diagnostics } = await setup()
    const ids = addEnvironments(deps, 4)
    for (const id of ids) {
      await store(deps, ios(), id)
      await store(deps, android(), id)
      passkeys(deps, true, RP_ID, id, {
        urls: {
          allowedOrigins: ['https://app.canary-origin.example'],
          allowedRedirectUrls: ['https://app.canary-origin.example/callback'],
        },
      })
    }
    const found = await native(deps)
    expect(found.files.status).toBe('ok')
    expect(found.files.summary).toContain(
      '(in 4 environments). 2 of them, fetched at PUBLIC_URL, the server’s own address,'
    )
    const fetched = diagnostics.requested.filter((url) => url.includes('.well-known'))
    // A sample: one file per platform, of the oldest environment that has such an app.
    expect(fetched).toHaveLength(Instance.NATIVE_APP_FILES_FETCHED)
    for (const url of diagnostics.requested) {
      expect(url.startsWith(`${PUBLIC_URL}/v1/`)).toBe(true)
    }
    for (const url of fetched) {
      expect(url).toContain(`/v1/environments/${ids[0]}/.well-known/`)
    }
  })

  test('the sample takes each platform from the oldest environment that has it', async () => {
    const { deps, diagnostics } = await setup()
    const [first, second, third] = addEnvironments(deps, 3)
    await store(deps, android(), first)
    // A second environment with the same platform is not a second sample of it.
    await store(deps, android(), second)
    await store(deps, ios(), third)
    expect((await native(deps)).files.status).toBe('ok')
    expect(diagnostics.requested.filter((url) => url.includes('.well-known')).sort()).toEqual([
      `${PUBLIC_URL}/v1/environments/${first}/.well-known/assetlinks.json`,
      `${PUBLIC_URL}/v1/environments/${third}/.well-known/apple-app-site-association`,
    ])
  })

  test('an address that serves no such file: a failure with the status', async () => {
    // The memory probe as it comes: nothing is behind PUBLIC_URL.
    const deps = createTestDeps({ config: PUBLIC })
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await store(deps, ios())
    const { files } = await native(deps)
    expect(files.status).toBe('fail')
    expect(files.summary).toEndWith('a file is answered with HTTP 404 instead of the file.')
  })
})

describe('the native_app_identities check', () => {
  const MALFORMED: [string, Partial<NativeAppRecord>][] = [
    ['a bundle id with a wildcard', { identifier: 'com.canary-bundle.*' }],
    ['a team that is not ten upper-case characters', { teamId: 'canaryteam' }],
    ['an iOS app with no team', { teamId: null }],
    ['an iOS app with a fingerprint', { sha256CertFingerprints: [AA] }],
    ['a package name of one segment', android('canary_package')],
    ['an Android app with no fingerprint', android(PACKAGE, [])],
    ['a fingerprint that is not one', android(PACKAGE, ['CANARY-not-a-fingerprint'])],
    ['a fingerprint in lower case', android(PACKAGE, [AA.toLowerCase()])],
    ['a fingerprint stored twice', android(PACKAGE, [AA, AA])],
    ['fingerprints that are not sorted', android(PACKAGE, [BB, AA])],
    ['an Android app with a team', { ...android(), teamId: TEAM }],
    ['a platform this version does not know', { platform: 'canaryos' as 'ios' }],
  ]

  test.each(MALFORMED)('%s is not well formed: a failure with a count', async (_name, app) => {
    const { deps } = await setup()
    const log = logged()
    const bad = await store(deps, app)
    await store(deps, ios('com.example.fine'))
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_identities')).toEqual({
      id: 'native_app_identities',
      status: 'fail',
      summary:
        '1 of the 2 native apps registered in 1 environment is not well formed: a bundle ID, a package name, a team ID or a certificate fingerprint this version refuses, or an Android app with no fingerprint.',
      fix: 'Remove each such app and register it again with the right values. The API’s log names each one by its id, under `native app is not well formed`. Native apps are managed on the dashboard’s native apps screen, through `/v1/admin/native-apps`, or as `nativeApps` in `tula.config.ts` with `tula apply` (docs/native-apps.md).',
    })
    expectNothingNamed(result, deps)
    // The log names the row by the id the server made, and by nothing an operator typed.
    expect(log()).toContain(bad.id)
    for (const typed of [TEAM, 'canary', 'CANARY', AA, BB]) {
      expect(log()).not.toContain(typed)
    }
  })

  test('it counts apps across environments', async () => {
    const { deps } = await setup()
    const [other] = addEnvironments(deps, 1)
    await store(deps, android(PACKAGE, []))
    await store(deps, ios())
    await store(deps, { teamId: null }, other)
    const { identities } = await native(deps)
    expect(identities.status).toBe('fail')
    expect(identities.summary).toStartWith(
      '2 of the 3 native apps registered in 2 environments are not well formed'
    )
  })

  test('more apps than an environment may have: a warning, and one app fewer is none', async () => {
    const { deps } = await setup({ config: TEST_CONFIG })
    for (let n = 0; n < MAX_NATIVE_APPS; n += 1) {
      await store(deps, ios(`com.example.app${n}`))
    }
    expect((await native(deps)).identities.status).toBe('ok')
    await store(deps, ios('com.example.onemore'))
    expect((await native(deps)).identities).toEqual({
      id: 'native_app_identities',
      status: 'warn',
      summary:
        'More than 20 native apps, the most an environment may have, are registered in 1 environment: a further registration there is refused.',
      fix: 'Remove the apps that are no longer shipped. Native apps are managed on the dashboard’s native apps screen, through `/v1/admin/native-apps`, or as `nativeApps` in `tula.config.ts` with `tula apply` (docs/native-apps.md).',
    })
  })
})

describe('the native_app_files check', () => {
  test('an app the route cannot serve: the files do not name the stored apps, and nothing is fetched for it', async () => {
    const { deps, diagnostics } = await setup()
    const log = logged()
    // An Android app with no fingerprint: the public route refuses to answer with it.
    await store(deps, android(PACKAGE, []))
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_files')).toEqual({
      id: 'native_app_files',
      status: 'fail',
      summary:
        'The association files the server builds do not name exactly the registered native apps, in 1 environment.',
      fix: 'A stored app that is not well formed does this (see `native_app_identities`): remove it and register it again. If every app is well formed this is a fault in the server: report it with the API’s version. The API’s log names the environments, under `the association files do not name exactly the stored apps`.',
    })
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toEqual([])
    expectNothingNamed(result, deps)
    expect(log()).toContain(TEST_TENANT.environmentId)
    expect(log()).not.toContain(PACKAGE)
  })

  test.each([
    [
      'leaves an app out',
      (): ReturnType<typeof NativeApps.associationFiles> => ({ apple: {}, android: [] }),
    ],
    [
      'names an app nobody registered',
      (): ReturnType<typeof NativeApps.associationFiles> => ({
        apple: { webcredentials: { apps: [`${TEAM}.${BUNDLE}`, `${TEAM}.com.example.other`] } },
        android: [],
      }),
    ],
    [
      'gives an Android app another relation',
      (): ReturnType<typeof NativeApps.associationFiles> => ({
        apple: { webcredentials: { apps: [`${TEAM}.${BUNDLE}`] } },
        android: [
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
              namespace: 'android_app',
              package_name: PACKAGE,
              sha256_cert_fingerprints: [AA, BB],
            },
          },
        ],
      }),
    ],
    [
      'gives an Android app another fingerprint',
      (): ReturnType<typeof NativeApps.associationFiles> => ({
        apple: { webcredentials: { apps: [`${TEAM}.${BUNDLE}`] } },
        android: [
          {
            relation: ['delegate_permission/common.get_login_creds'],
            target: {
              namespace: 'android_app',
              package_name: PACKAGE,
              sha256_cert_fingerprints: [AA],
            },
          },
        ],
      }),
    ],
  ])('a file that %s fails, whatever the stored apps look like', async (_name, files) => {
    const { deps } = await setup()
    await store(deps, ios())
    await store(deps, android())
    expect((await native(deps)).files.status).toBe('ok')
    spies.push(spyOn(NativeApps, 'associationFiles').mockImplementation(files))
    const found = await native(deps)
    expect(found.files.status).toBe('fail')
    expect(found.files.summary).toStartWith('The association files the server builds do not name')
    expect(found.identities.status).toBe('ok')
  })

  const BUILT =
    'The association files the server builds name exactly the registered native apps (in 1 environment).'
  const ADDRESS =
    'Check the proxy in front of the API: it must pass `/v1/environments/<id>/.well-known/apple-app-site-association` and `…/assetlinks.json` on to the API unchanged, with no redirect, and your own domain must answer `/.well-known/…` with what those paths return (docs/native-apps.md).'

  const WALL =
    'An access wall or a firewall in front of the API’s own host answered, not the API: the two routes take no key. That says nothing about what the apps’ own domain serves, which the server never requests. Apple and Android fetch `/.well-known/…` there with no credentials: make sure both paths reach the API with nothing asking for a sign-in on the way (docs/native-apps.md).'

  const ANSWERS: [
    string,
    (document: FetchedDocument) => FetchedDocument,
    Omit<DiagnosticCheck, 'id'>,
  ][] = [
    [
      'a redirect',
      () => ({ status: 302, contentType: 'text/html', body: null }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file is answered with a redirect: Apple and Android follow none.`,
        fix: ADDRESS,
      },
    ],
    [
      'another status',
      () => ({ status: 503, contentType: 'application/json', body: null }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file is answered with HTTP 503 instead of the file.`,
        fix: ADDRESS,
      },
    ],
    ...([401, 403] as const).map((status): (typeof ANSWERS)[number] => [
      `HTTP ${status}: an access wall in front of the API’s own host`,
      () => ({ status, contentType: 'text/html', body: null }),
      {
        status: 'warn',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file is answered with HTTP ${status}: something in front of the API asks for credentials or refuses the request, so the file was not seen.`,
        fix: WALL,
      },
    ]),
    [
      'a status next to those two (402)',
      () => ({ status: 402, contentType: 'text/html', body: null }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file is answered with HTTP 402 instead of the file.`,
        fix: ADDRESS,
      },
    ],
    [
      'a page instead of JSON',
      (document) => ({ ...document, contentType: 'text/html; charset=utf-8' }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file does not come back as JSON (\`application/json\`), which both platforms require.`,
        fix: ADDRESS,
      },
    ],
    [
      'no content type',
      (document) => ({ ...document, contentType: null }),
      { status: 'fail' } as Omit<DiagnosticCheck, 'id'>,
    ],
    [
      'a content type that only starts like JSON',
      (document) => ({ ...document, contentType: 'application/jsonp' }),
      { status: 'fail' } as Omit<DiagnosticCheck, 'id'>,
    ],
    [
      'a body that is not JSON',
      (document) => ({ ...document, body: '<html>CANARY-page</html>' }),
      { status: 'fail' } as Omit<DiagnosticCheck, 'id'>,
    ],
    [
      'a body past the cap',
      (document) => ({ ...document, body: null }),
      { status: 'fail' } as Omit<DiagnosticCheck, 'id'>,
    ],
    [
      'another body',
      (document) => ({
        ...document,
        body: JSON.stringify({ webcredentials: { apps: ['CANARYOTHER.com.canary-cached.app'] } }),
      }),
      {
        status: 'warn',
        summary: `${BUILT} But fetched at PUBLIC_URL, the server’s own address, a file comes back different from what the server builds now.`,
        fix: 'A cache in front of the API may keep a copy for five minutes after an app was changed (`Cache-Control: max-age=300`): run the check again later. If the file stays different, something in front of the API changes the answer: have it pass the file on unchanged.',
      },
    ],
  ]

  test.each(ANSWERS)('%s at PUBLIC_URL', async (_name, change, expected) => {
    const { deps } = await setup()
    await store(deps, ios())
    serve(deps, change)
    const log = logged()
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_files')).toMatchObject(expected)
    expectNothingNamed(result, deps)
    expect(log()).not.toContain('CANARY')
    // What was seen to be wrong is the address: the stored apps are as good as before.
    expect(byId(result.checks, 'native_app_identities').status).toBe('ok')
  })

  test('JSON with a charset, and with its keys in another order, is the file', async () => {
    const { deps } = await setup()
    await store(deps, android())
    serve(deps, (document) => {
      const [statement] = JSON.parse(document.body ?? '[]')
      const body = JSON.stringify([{ target: statement.target, relation: statement.relation }])
      return { ...document, contentType: 'Application/JSON; charset=utf-8', body }
    })
    expect((await native(deps)).files.status).toBe('ok')
  })

  test('no answer: a warning, and nothing of the reason in the answer', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    diagnostics.httpDocument = async () => {
      throw new Error('getaddrinfo ENOTFOUND CANARY-internal-message')
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_files')).toEqual({
      id: 'native_app_files',
      status: 'warn',
      summary: `${BUILT} But a file could not be fetched at PUBLIC_URL, the server’s own address: there was no answer in time.`,
      fix: 'See the `public_url` check: the server could not reach its own address, so whether the files are served there was not seen.',
    })
    expectNothingNamed(result, deps)
  })

  test('a fetch that never answers is cut off, and the scan’s findings stand', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    diagnostics.httpDocument = () => new Promise<never>(() => {})
    const found = await native(deps, 40)
    expect(found.files.status).toBe('warn')
    expect(found.identities.status).toBe('ok')
  })

  test('the worst answer of the sample decides', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    await store(deps, android())
    const served = diagnostics.httpDocument
    diagnostics.httpDocument = async (url, timeoutMs) => {
      if (url.endsWith('assetlinks.json')) {
        diagnostics.requested.push(url)
        return { status: 301, contentType: null, body: null }
      }
      return served(url, timeoutMs)
    }
    expect((await native(deps)).files.summary).toContain('answered with a redirect')
  })

  test.each([
    ['a redirect', { status: 302, contentType: null, body: null }, 'answered with a redirect'],
    ['another status', { status: 500, contentType: null, body: null }, 'answered with HTTP 500'],
    [
      'a page',
      { status: 200, contentType: 'text/html', body: '<p>' },
      'does not come back as JSON',
    ],
  ])(
    '%s for one file fails, whatever an access wall answers for the other',
    async (_name, answer, words) => {
      for (const walled of ['assetlinks.json', 'apple-app-site-association']) {
        const { deps, diagnostics } = await setup()
        await store(deps, ios())
        await store(deps, android())
        diagnostics.httpDocument = async (url) =>
          url.endsWith(walled) ? { status: 403, contentType: null, body: null } : answer
        const { files } = await native(deps)
        expect(files.status).toBe('fail')
        expect(files.summary).toContain(words)
      }
    }
  )

  test('an access wall is said before a cached copy or no answer', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    await store(deps, android())
    diagnostics.httpDocument = async (url) => {
      if (url.endsWith('assetlinks.json')) {
        return { status: 401, contentType: null, body: null }
      }
      throw new Error('no answer')
    }
    expect((await native(deps)).files.summary).toContain('answered with HTTP 401:')
  })

  test('concurrent callers share one run: each file is fetched once', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    const [first, second] = await Promise.all([
      Instance.diagnostics(deps),
      Instance.diagnostics(deps),
    ])
    expect(second).toBe(first)
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toHaveLength(1)
  })
})

describe('the native_app_passkeys check', () => {
  const PROXY =
    'That domain must answer `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` by passing the request on to this API (docs/native-apps.md). This check cannot see whether it does: the server never requests your domain.'

  const FIX = `Set \`passkeys.rpId\` in those environments’ settings to the domain the apps name as their associated domain (changing it orphans the passkeys already registered). ${PROXY}`
  const OFF =
    'Passkeys are switched off in 1 environment with native apps, so the apps there use the association files for saved passwords only.'
  const LOOPBACK =
    'Passkeys are on in 1 environment with native apps where the relying party (`passkeys.rpId`) is `localhost` or a loopback name. A platform cannot associate an app with a loopback name, which is expected on a developer’s machine (ENVIRONMENT=local).'
  const TIERS = ['local', 'dev', 'staging', 'prod'] as const
  const tier = (name: (typeof TIERS)[number]) => ({ config: { ...PUBLIC, tier: name } })

  // Review finding F1: the files serve saved-password autofill too, so apps with passkeys off
  // is an end state an operator may want, and `tula doctor --strict` must not fail it.
  test.each([...TIERS])(
    'passkeys off where apps are registered, in %s: ok, and it says what the files are for',
    async (name) => {
      const { deps } = await setup(tier(name))
      await store(deps, ios())
      passkeys(deps, false, RP_ID)
      const result = await Instance.diagnostics(deps)
      expect(byId(result.checks, 'native_app_passkeys')).toEqual({
        id: 'native_app_passkeys',
        status: 'ok',
        summary: OFF,
      })
      expectNothingNamed(result, deps)
    }
  )

  test('an environment that saved no settings has passkeys off', async () => {
    const { deps } = await setup()
    await store(deps, ios())
    expect((await native(deps)).passkeys).toMatchObject({ status: 'ok', summary: OFF })
  })

  test('passkeys off, whatever the relying party says: it is not looked at', async () => {
    const { deps } = await setup(tier('prod'))
    await store(deps, ios())
    passkeys(deps, false, 'localhost')
    expect((await native(deps)).passkeys).toMatchObject({ status: 'ok', summary: OFF })
  })

  const NOT_A_DOMAIN: [string, string | null][] = [
    ['no relying party at all', null],
    ['an IP address', '203.0.113.7'],
    ['the loopback IP address', '127.0.0.1'],
    ['a name with a scheme', 'https://canary-rp.example'],
    ['a single label', 'canary'],
  ]
  const LOOPBACK_NAMES: [string, string][] = [
    ['localhost', 'localhost'],
    ['a name under .localhost', 'canary.localhost'],
  ]

  test.each(
    (['dev', 'staging', 'prod'] as const).flatMap((name) =>
      [...LOOPBACK_NAMES, ...NOT_A_DOMAIN].map(([what, rpId]) => [name, what, rpId] as const)
    )
  )('in %s, passkeys on with %s: a warning that names nothing', async (name, _what, rpId) => {
    const { deps } = await setup(tier(name))
    await store(deps, android())
    passkeys(deps, true, rpId)
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'warn',
      summary:
        'Passkeys are on in 1 environment with native apps where the relying party (`passkeys.rpId`) is not a domain a platform can associate with an app: it is not set, it is `localhost` or a loopback name, or it is no domain name. The apps there cannot use passkeys.',
      fix: FIX,
    })
    expectNothingNamed(result, deps)
  })

  // Review finding F5: on a developer's machine a loopback relying party is what one has.
  test.each(LOOPBACK_NAMES)(
    'in the local tier, passkeys on with %s: ok, with a note',
    async (_what, rpId) => {
      const { deps } = await setup(tier('local'))
      await store(deps, android())
      passkeys(deps, true, rpId)
      const result = await Instance.diagnostics(deps)
      expect(byId(result.checks, 'native_app_passkeys')).toEqual({
        id: 'native_app_passkeys',
        status: 'ok',
        summary: LOOPBACK,
      })
      expectNothingNamed(result, deps)
    }
  )

  test.each(NOT_A_DOMAIN)(
    'in the local tier too, passkeys on with %s: a warning',
    async (_what, rpId) => {
      const { deps } = await setup(tier('local'))
      await store(deps, android())
      passkeys(deps, true, rpId)
      const result = await Instance.diagnostics(deps)
      expect(byId(result.checks, 'native_app_passkeys')).toEqual({
        id: 'native_app_passkeys',
        status: 'warn',
        summary:
          'Passkeys are on in 1 environment with native apps where the relying party (`passkeys.rpId`) is not a domain a platform can associate with an app: it is not set or it is no domain name. The apps there cannot use passkeys.',
        fix: FIX,
      })
      expectNothingNamed(result, deps)
    }
  )

  test('the tier is the configuration’s ENVIRONMENT, never NODE_ENV', async () => {
    const before = process.env.NODE_ENV
    try {
      for (const nodeEnv of ['development', 'production']) {
        process.env.NODE_ENV = nodeEnv
        for (const [name, status] of [
          ['local', 'ok'],
          ['prod', 'warn'],
        ] as const) {
          const { deps } = await setup(tier(name))
          await store(deps, ios())
          passkeys(deps, true, 'localhost')
          expect((await native(deps)).passkeys.status).toBe(status)
        }
      }
    } finally {
      process.env.NODE_ENV = before
    }
  })

  // Review round 1 of TULA-31, F1: an iOS app presents `https://<rpId>`, a page's origin,
  // and the server accepts it only where the environment allows that page. An operator who
  // registers an iOS app and has not allowed it gets refusals that nothing else explains.
  const IOS_REFUSED =
    'Passkeys are on in 1 environment with an iOS app where the allowed origins (`urls.allowedOrigins`) do not list the relying party’s own origin, `https://` and `passkeys.rpId`. An iOS app presents that origin, so its passkey requests are refused there.'
  const IOS_FIX =
    'Add the relying party’s own origin, `https://` followed by `passkeys.rpId`, to `urls.allowedOrigins` in those environments’ settings. It is also a page’s origin: allowing it lets a page at that address use the client API from a browser. An Android app needs no such entry (docs/native-apps.md).'
  const ELSEWHERE: [string, string[]][] = [
    ['no origin at all', []],
    ['only a page under the relying party', [`https://app.${RP_ID}`]],
    ['the relying party over http', [`http://${RP_ID}`]],
    ['the relying party on another port', [`https://${RP_ID}:8443`]],
    ['only another site', ['https://canary-other.example']],
  ]

  test.each(
    TIERS.flatMap((name) => ELSEWHERE.map(([what, allowed]) => [name, what, allowed] as const))
  )(
    'in %s, an iOS app, passkeys on and %s allowed: a warning that names nothing',
    async (name, _what, allowed) => {
      const { deps } = await setup(tier(name))
      await store(deps, ios())
      await store(deps, android())
      passkeys(deps, true, RP_ID, undefined, { urls: origins(allowed) })
      const result = await Instance.diagnostics(deps)
      expect(byId(result.checks, 'native_app_passkeys')).toEqual({
        id: 'native_app_passkeys',
        status: 'warn',
        summary: IOS_REFUSED,
        fix: IOS_FIX,
      })
      expectNothingNamed(result, deps)
      expect(JSON.stringify(result)).not.toContain('canary-other')
    }
  )

  test('the relying party’s own origin allowed, beside others: nothing to put right', async () => {
    const { deps } = await setup(tier('prod'))
    await store(deps, ios())
    passkeys(deps, true, RP_ID, undefined, {
      urls: origins([`https://app.${RP_ID}`, `https://${RP_ID}`]),
    })
    const check = (await native(deps)).passkeys
    expect(check.status).toBe('ok')
    expect(check.summary).not.toContain('iOS')
  })

  test('an Android app alone needs no such origin: it presents no page’s', async () => {
    const { deps } = await setup(tier('prod'))
    await store(deps, android())
    passkeys(deps, true, RP_ID, undefined, { urls: origins([]) })
    expect((await native(deps)).passkeys.status).toBe('ok')
  })

  test('passkeys off, or a relying party no platform associates: said as that, not as the iOS finding', async () => {
    for (const [enabled, rpId] of [
      [false, RP_ID],
      [true, null],
      [true, 'localhost'],
    ] as const) {
      const { deps } = await setup(tier('prod'))
      await store(deps, ios())
      passkeys(deps, enabled, rpId, undefined, { urls: origins([]) })
      expect((await native(deps)).passkeys.summary).not.toContain('iOS')
    }
  })

  test('the iOS finding counts environments, and leads when no relying party is wrong', async () => {
    const { deps } = await setup(tier('prod'))
    const [refused, alsoRefused, alsoFine, fine, off] = addEnvironments(deps, 5)
    for (const id of [refused, alsoRefused, alsoFine, fine, off]) {
      await store(deps, ios(), id)
    }
    passkeys(deps, true, RP_ID, refused, { urls: origins([]) })
    passkeys(deps, true, RP_ID, alsoRefused, { urls: origins([`https://app.${RP_ID}`]) })
    passkeys(deps, true, RP_ID, fine)
    passkeys(deps, false, RP_ID, off, { urls: origins([]) })
    passkeys(deps, true, RP_ID, alsoFine)
    const alone = (await native(deps)).passkeys
    expect(alone.status).toBe('warn')
    expect(alone.summary).toBe(
      `${IOS_REFUSED.replace('in 1 environment', 'in 2 environments')} In 1 more, passkeys are switched off.`
    )
    expect(alone.fix).toBe(IOS_FIX)
  })

  test('beside a relying party that is unset, the iOS finding is a clause with its count', async () => {
    const { deps } = await setup(tier('prod'))
    const [refused, unset] = addEnvironments(deps, 2)
    await store(deps, ios(), refused)
    await store(deps, ios(), unset)
    passkeys(deps, true, RP_ID, refused, { urls: origins([]) })
    passkeys(deps, true, null, unset)
    const check = (await native(deps)).passkeys
    expect(check.status).toBe('warn')
    expect(check.summary).toEndWith(
      'The apps there cannot use passkeys. In 1 more, iOS passkeys are refused.'
    )
    // Review round 2, F4: the fix covers both findings the summary names.
    expect(check.fix).toBe(
      `${FIX} Where iOS passkeys are refused, add \`https://\` and \`passkeys.rpId\` to \`urls.allowedOrigins\`.`
    )
  })

  async function mixed(name: (typeof TIERS)[number], unset: boolean) {
    const { deps } = await setup(tier(name))
    const [off, local, fine, noApps, none] = addEnvironments(deps, 5)
    await store(deps, ios())
    await store(deps, ios(), off)
    await store(deps, ios(), local)
    await store(deps, ios(), fine)
    passkeys(deps, false, null, off)
    passkeys(deps, true, 'localhost', local)
    passkeys(deps, true, RP_ID, fine)
    // No app here: its relying party is nobody's business.
    passkeys(deps, true, 'localhost', noApps)
    if (unset) {
      await store(deps, ios(), none)
      passkeys(deps, true, null, none)
    }
    return (await native(deps)).passkeys
  }

  test('it counts environments, apart for each finding, and only those with apps', async () => {
    const check = await mixed('prod', false)
    expect(check.status).toBe('warn')
    expect(check.summary).toStartWith('Passkeys are on in 1 environment with native apps where')
    expect(check.summary).toEndWith(
      'The apps there cannot use passkeys. In 2 more, passkeys are switched off.'
    )
  })

  test('in the local tier the same environments are ok: each finding with its count', async () => {
    expect(await mixed('local', false)).toEqual({
      id: 'native_app_passkeys',
      status: 'ok',
      summary:
        'Passkeys are on in 1 environment with native apps, with a relying party a platform can associate with an app. Whether that domain serves the files was not checked: the server never requests it. In 1 more, the relying party is a loopback name, which no platform associates with an app: expected on a developer’s machine. In 2 more, passkeys are off: the apps there use the files for saved passwords only.',
    })
  })

  test('one relying party that is unset is a warning in the local tier too, beside the loopback and the switched-off ones', async () => {
    const check = await mixed('local', true)
    expect(check.status).toBe('warn')
    expect(check.summary).toBe(
      'Passkeys are on in 1 environment with native apps where the relying party (`passkeys.rpId`) is not a domain a platform can associate with an app: it is not set or it is no domain name. The apps there cannot use passkeys. In 1 more, the relying party is a loopback name, which no platform associates with an app: expected on a developer’s machine. In 2 more, passkeys are switched off.'
    )
    expect(check.fix).toBe(FIX)
  })

  test('settings that cannot be read: skipped, the reason stays out, the other two checks stand', async () => {
    const { deps } = await setup()
    const ids = addEnvironments(deps, 3)
    await store(deps, ios())
    for (const id of ids) {
      await store(deps, ios(), id)
    }
    let read = 0
    deps.environmentSettings.get = async () => {
      read += 1
      throw new Error('could not read settings: CANARY-internal-message')
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'skipped',
      summary: 'Not checked: the environments’ settings could not be read from the database.',
    })
    expect(byId(result.checks, 'native_app_identities').status).toBe('ok')
    expect(byId(result.checks, 'native_app_files').status).toBe('ok')
    expect(byId(result.checks, 'master_key').status).toBe('ok')
    // After one failed read it asks no further environment.
    expect(read).toBe(1)
    expectNothingNamed(result, deps)
  })

  test('an environment’s settings are read once a run, whichever checks need them', async () => {
    const { deps } = await setup({ sms: unconfiguredSmsSender } as unknown as Partial<TestDeps>)
    await store(deps, ios())
    const asked: string[] = []
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    deps.environmentSettings.get = async (environmentId, ...rest) => {
      asked.push(environmentId)
      return get(environmentId, ...rest)
    }
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'sms_sender').status).toBe('skipped')
    expect(byId(result.checks, 'native_app_passkeys').summary).toStartWith(
      'Passkeys are switched off'
    )
    expect(asked).toEqual([TEST_TENANT.environmentId])
  })
})

describe('bounded work', () => {
  test('a store that fails: the three checks are skipped, the reason stays out, the others stand', async () => {
    const { deps } = await setup()
    addEnvironments(deps, 3)
    await store(deps, ios())
    let calls = 0
    deps.nativeApps.list = async () => {
      calls += 1
      throw new Error(`relation native_apps: CANARY-internal-message ${BUNDLE}`)
    }
    const result = await Instance.diagnostics(deps)
    for (const id of NATIVE_IDS) {
      expect(byId(result.checks, id)).toEqual({
        id,
        status: 'skipped',
        summary: 'Not checked: the native apps could not be read from the database.',
      })
    }
    // The apps' failure is not the stored secrets' nor the outbox's.
    expect(byId(result.checks, 'master_key').status).toBe('ok')
    expect(byId(result.checks, 'webhook_worker').status).toBe('ok')
    // After one failed read it asks no further environment.
    expect(calls).toBe(1)
    expectNothingNamed(result, deps)
  })

  // Review finding F4, kept on purpose: a check never reports from a partial read as if it
  // were whole, so a failure already found is not said either. The log still has it.
  test('a store that fails for a later environment: skipped, though an earlier one held a malformed app, which the log still names', async () => {
    const { deps, diagnostics } = await setup()
    const [second] = addEnvironments(deps, 1)
    const malformed = await store(deps, { teamId: null })
    const list = deps.nativeApps.list.bind(deps.nativeApps)
    deps.nativeApps.list = async (environmentId) => {
      if (environmentId === second) {
        throw new Error('CANARY-internal-message')
      }
      return list(environmentId)
    }
    const log = logged()
    const result = await Instance.diagnostics(deps)
    for (const id of NATIVE_IDS) {
      expect(byId(result.checks, id)).toEqual({
        id,
        status: 'skipped',
        summary: 'Not checked: the native apps could not be read from the database.',
      })
    }
    expect(log()).toContain('native app is not well formed')
    expect(log()).toContain(malformed.id)
    // The reason is the log's (never the answer's), beside the row an operator can still find.
    expect(log()).toContain('diagnostic check failed')
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toEqual([])
    expectNothingNamed(result, deps)

    // The other order: the first read fails, and the second environment is not read at all.
    deps.nativeApps.list = async (environmentId) => {
      if (environmentId !== second) {
        throw new Error('CANARY-internal-message')
      }
      return list(environmentId)
    }
    expect((await native(deps)).identities.status).toBe('skipped')
  })

  test('a scan that fails altogether skips them too, and fetches nothing', async () => {
    const { deps, diagnostics } = await setup()
    await store(deps, ios())
    deps.environments.listAll = async () => {
      throw new Error('CANARY-internal-message')
    }
    const result = await Instance.diagnostics(deps)
    for (const id of NATIVE_IDS) {
      expect(byId(result.checks, id).status).toBe('skipped')
    }
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toEqual([])
    expectNothingNamed(result, deps)
  })

  test('more environments than one run reads: one read each, and it says how many it looked at', async () => {
    const { deps } = await setup()
    const ids = addEnvironments(deps, Instance.MAX_ENVIRONMENTS_CHECKED)
    const asked: string[] = []
    const list = deps.nativeApps.list.bind(deps.nativeApps)
    deps.nativeApps.list = async (environmentId) => {
      asked.push(environmentId)
      return list(environmentId)
    }
    // The newest environment, past the 200th, has an app that is not well formed: it is not
    // read, and no check says "none" or "ok".
    await store(deps, { teamId: null }, ids.at(-1))
    const none = await Instance.diagnostics(deps)
    for (const id of NATIVE_IDS) {
      expect(byId(none.checks, id)).toEqual({
        id,
        status: 'warn',
        summary:
          'Only the first 200 of 201 environments were read; the other 1 were not. None of those read has a native app.',
        fix: 'One run reads the native apps of the 200 oldest environments only. A newer environment’s apps were not checked.',
      })
    }
    expect(asked).toHaveLength(Instance.MAX_ENVIRONMENTS_CHECKED)
    expect(new Set(asked).size).toBe(Instance.MAX_ENVIRONMENTS_CHECKED)
    expect(asked).not.toContain(ids.at(-1))

    await store(deps, ios())
    passkeys(deps, true, RP_ID)
    const some = await native(deps)
    expect(some.identities.status).toBe('warn')
    expect(some.identities.summary).toBe(
      'Only the first 200 of 201 environments were read; the other 1 were not. The 1 native app registered in 1 environment is well formed: each passes the rules a registration is held to. Whether a bundle ID, a team or a fingerprint is the one your app really has cannot be checked from here.'
    )
    expect(some.files.status).toBe('warn')
    expect(some.files.summary).toStartWith(
      'Only the first 200 of 201 environments were read; the other 1 were not. The association files'
    )
    expect(some.passkeys.status).toBe('warn')
    expect(some.passkeys.fix).toBe(
      'One run reads the native apps of the 200 oldest environments only. A newer environment’s apps were not checked.'
    )

    await store(deps, android(PACKAGE, []))
    expect((await native(deps)).identities.summary).toStartWith(
      'Only the first 200 of 201 environments were read; the other 1 were not. 1 of the 2 native apps registered in 1 environment is not well formed'
    )
  })

  test('a scan cut off by the timeout reads no further environment’s apps', async () => {
    const { deps, diagnostics } = await setup()
    addEnvironments(deps, 5)
    await store(deps, ios())
    let calls = 0
    deps.nativeApps.list = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 80))
      return []
    }
    const result = await Instance.diagnostics(deps, 50)
    for (const id of NATIVE_IDS) {
      expect(byId(result.checks, id).status).toBe('skipped')
    }
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls).toBe(1)
    expect(diagnostics.requested.filter((url) => url.includes('.well-known'))).toEqual([])
  })

  test('a deadline that passes inside an environment: its apps are not read after it', async () => {
    const { deps } = await setup()
    await store(deps, ios())
    let calls = 0
    const list = deps.nativeApps.list.bind(deps.nativeApps)
    deps.nativeApps.list = async (environmentId) => {
      calls += 1
      return list(environmentId)
    }
    // The call before the apps' outlasts the deadline: the caller has stopped waiting.
    const pending = deps.webhookDeliveries.oldestPendingEventAt.bind(deps.webhookDeliveries)
    deps.webhookDeliveries.oldestPendingEventAt = async (environmentId) => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return pending(environmentId)
    }
    expect((await native(deps, 40)).identities.status).toBe('skipped')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toBe(0)
  })

  test('apps that never answer: later runs do not read them again on top of it', async () => {
    const { deps } = await setup()
    let calls = 0
    deps.nativeApps.list = () => {
      calls += 1
      return new Promise<never>(() => {})
    }
    expect((await native(deps, 50)).identities.status).toBe('skipped')
    expect((await native(deps, 50)).identities.status).toBe('skipped')
    expect(calls).toBe(1)
  })
})

describe('what an answer may hold', () => {
  test('healthy or not, no identifier, team, fingerprint, relying party or environment id', async () => {
    const { deps } = await setup({ config: { ...PUBLIC, tier: 'prod' } })
    const [bad, cached] = addEnvironments(deps, 2)
    await store(deps, ios())
    await store(deps, android())
    passkeys(deps, true, RP_ID)
    const healthy = await Instance.diagnostics(deps)
    expect(NATIVE_IDS.map((id) => byId(healthy.checks, id).status)).toEqual(['ok', 'ok', 'ok'])
    expectNothingNamed(healthy, deps)

    await store(deps, { identifier: 'com.canary-bundle.*', teamId: 'canaryteam' }, bad)
    await store(deps, android(PACKAGE, [AA.toLowerCase()]), bad)
    await store(deps, ios(), cached)
    passkeys(deps, true, 'canary.localhost', bad)
    serve(deps, (document) => ({ ...document, body: JSON.stringify({ canary: BUNDLE }) }))
    const unhealthy = await Instance.diagnostics(deps)
    expect(NATIVE_IDS.map((id) => byId(unhealthy.checks, id).status)).toEqual([
      'fail',
      'warn',
      'warn',
    ])
    expectNothingNamed(unhealthy, deps)
    for (const check of unhealthy.checks) {
      expect(check.values).toBeUndefined()
      expect(check.fix === undefined).toBe(check.status === 'ok' || check.status === 'skipped')
    }
  })

  // `@tula/mcp` cuts a string at 512 characters and `tula doctor` at 600. Review finding F6:
  // with a scan that did not read every environment and every passkey state present, the
  // summary was 564 characters and the part cut off was "the other K were not read", the
  // sentence that keeps a check from claiming more than it looked at. So every answer the
  // three checks can give is built here, not a hand-picked few: each finding present or
  // absent, both tiers, every pair of fetch outcomes, read whole or not, at the largest
  // counts a scan can produce and a deployment of millions of environments.
  describe('every sentence fits what the CLI and the MCP server keep of one', () => {
    const CAP = 512
    const MOST = Instance.MAX_ENVIRONMENTS_CHECKED
    const MILLIONS = 9_999_999
    const NOTICE = `Only the first ${MOST} of ${MILLIONS} environments were read; the other ${MILLIONS - MOST} were not.`
    const either = [0, MOST] as const
    const scans = [
      { whole: true, environments: MOST },
      { whole: false, environments: MILLIONS },
    ]
    const scanned = (environments: number, over: Partial<Native.NativeFindings>) => ({
      value: {
        environments,
        checked: MOST,
        native: { ...Native.noFindings(), environments: MOST, apps: MILLIONS, ...over },
      },
    })
    const outcomes: Native.Fetched[] = [
      { kind: 'served' },
      { kind: 'unanswered' },
      { kind: 'redirect' },
      { kind: 'not_json' },
      { kind: 'different' },
      { kind: 'status', status: 401 },
      { kind: 'status', status: 403 },
      { kind: 'status', status: 599 },
    ]
    const fetches: Native.Fetched[][] = [
      [],
      ...outcomes.map((one) => [one]),
      ...outcomes.flatMap((one) => outcomes.map((other) => [one, other])),
    ]

    function all(): { whole: boolean; check: DiagnosticCheck }[] {
      const built: { whole: boolean; check: DiagnosticCheck }[] = []
      for (const { whole, environments } of scans) {
        const add = (check: DiagnosticCheck) => built.push({ whole, check })
        add(Native.identitiesCheck(scanned(environments, { apps: 0, environments: 0 })))
        for (const malformed of [0, MILLIONS]) {
          for (const overCap of either) {
            add(Native.identitiesCheck(scanned(environments, { malformed, overCap })))
          }
        }
        for (const mismatched of either) {
          for (const loopback of [true, false]) {
            for (const fetched of fetches) {
              add(Native.filesCheck(scanned(environments, { mismatched }), loopback, fetched))
            }
          }
        }
        for (const tier of ['local', 'dev', 'staging', 'prod'] as const) {
          add(Native.passkeysCheck(scanned(environments, { passkeys: null }), tier))
          for (const associable of either) {
            for (const off of either) {
              for (const loopback of either) {
                for (const unassociable of either) {
                  // The iOS finding is of environments whose relying party can be
                  // associated: there is none to refuse where there is none of those.
                  for (const iosRefused of associable > 0 ? either : [0]) {
                    const found = { off, loopback, unassociable, iosRefused }
                    const inAll = associable + off + loopback + unassociable
                    if (inAll > 0) {
                      const check = Native.passkeysCheck(
                        scanned(environments, { environments: inAll, passkeys: found }),
                        tier
                      )
                      add(check)
                      // Whatever else is found, an iOS finding is said and its fix is given.
                      if (iosRefused > 0) {
                        expect(check.status).toBe('warn')
                        expect(check.summary).toContain('iOS')
                        expect(check.fix).toContain('`urls.allowedOrigins`')
                      } else {
                        expect(check.summary).not.toContain('iOS')
                        expect(check.fix ?? '').not.toContain('urls.allowedOrigins')
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      return [
        ...built,
        ...[true, false].flatMap((whole) => [
          { whole, check: Native.identitiesCheck(null) },
          { whole, check: Native.filesCheck(null, false, []) },
          { whole, check: Native.passkeysCheck(null, 'prod') },
        ]),
      ].filter(({ whole, check }) => whole || check.summary !== SKIPPED_UNREAD)
    }
    const SKIPPED_UNREAD = 'Not checked: the native apps could not be read from the database.'

    test('whatever was found, at the largest counts', () => {
      const answers = all()
      // 2 scans x (5 identities + 2 x 2 x 73 files + 4 tiers x 24 passkeys: the 16 of
      // before and the 8 with an associable relying party over again with the iOS finding),
      // and the scan that failed.
      expect(answers).toHaveLength(2 * (5 + 292 + 96) + 3)
      expect(new Set(answers.map(({ check }) => check.status))).toEqual(
        new Set(['ok', 'skipped', 'warn', 'fail'])
      )
      const longest = (text: (check: DiagnosticCheck) => string) =>
        answers.reduce((most, { check }) => Math.max(most, text(check).length), 0)
      expect(longest((check) => check.summary)).toBeLessThanOrEqual(CAP)
      expect(longest((check) => check.fix ?? '')).toBeLessThanOrEqual(CAP)
    })

    test('a scan that did not read every environment says so first, in every answer', () => {
      for (const { whole, check } of all()) {
        if (whole) {
          expect(check.summary).not.toContain('Only the first')
        } else if (check.status === 'skipped') {
          // Only "the settings could not be read": it claims nothing about any environment.
          expect(check.summary).toStartWith('Not checked:')
        } else {
          expect(check.summary).toStartWith(`${NOTICE} `)
          // Said once, and never as "ok": something was not looked at.
          expect(check.summary.split('Only the first')).toHaveLength(2)
          expect(check.summary).not.toContain('of the first')
          expect(check.status).not.toBe('ok')
          expect(check.fix?.length ?? 0).toBeGreaterThan(0)
        }
      }
    })
  })
})
