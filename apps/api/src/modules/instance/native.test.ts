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
      ...more,
    },
  })
}

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
      summary: `The association files the server builds name exactly the registered native apps (in 1 environment). 2 of them, fetched at PUBLIC_URL, came back as built: HTTP 200, \`application/json\`, no redirect. These are the server’s own copies. ${NOT_THE_PLATFORMS}`,
    })
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'ok',
      summary:
        'Passkeys are on in 1 environment with native apps, and the relying party there is a domain a platform can associate with an app. Whether that domain serves the association files was not checked: the server never requests it.',
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
    expect(found.files.summary).toContain('One of them, fetched at PUBLIC_URL, came back as built')
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
      summary: `The association files the server builds name exactly the registered native apps (in 1 environment). They were not fetched: PUBLIC_URL is a loopback address, which the server cannot check from where it runs. ${NOT_THE_PLATFORMS}`,
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
    expect(found.files.summary).toContain('(in 4 environments). 2 of them, fetched at PUBLIC_URL')
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
        summary: `${BUILT} But fetched at PUBLIC_URL, a file is answered with a redirect: Apple and Android follow none.`,
        fix: ADDRESS,
      },
    ],
    [
      'another status',
      () => ({ status: 503, contentType: 'application/json', body: null }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, a file is answered with HTTP 503 instead of the file.`,
        fix: ADDRESS,
      },
    ],
    [
      'a page instead of JSON',
      (document) => ({ ...document, contentType: 'text/html; charset=utf-8' }),
      {
        status: 'fail',
        summary: `${BUILT} But fetched at PUBLIC_URL, a file does not come back as JSON (\`application/json\`), which both platforms require.`,
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
        summary: `${BUILT} But fetched at PUBLIC_URL, a file comes back different from what the server builds now.`,
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
      summary: `${BUILT} But a file could not be fetched at PUBLIC_URL: there was no answer in time.`,
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
    'That domain must answer `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` with the environment’s files, by passing the request on to this API (docs/native-apps.md). This check cannot see whether it does: the server never requests your domain.'

  test('passkeys off where apps are registered: a warning, never a failure', async () => {
    const { deps } = await setup()
    await store(deps, ios())
    passkeys(deps, false, RP_ID)
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'warn',
      summary:
        'Passkeys are switched off in 1 environment with native apps: the apps there cannot sign in with a passkey.',
      fix: `If the apps are meant to use passkeys, switch the passkey sign-in method on in those environments’ settings and set \`passkeys.rpId\` to the domain the apps name as their associated domain. ${PROXY} An app that only fills in saved passwords needs neither.`,
    })
    expectNothingNamed(result, deps)
  })

  test('an environment that saved no settings has passkeys off', async () => {
    const { deps } = await setup()
    await store(deps, ios())
    expect((await native(deps)).passkeys.status).toBe('warn')
  })

  test.each([
    ['localhost', 'localhost'],
    ['a name under .localhost', 'canary.localhost'],
    ['no relying party at all', null],
    ['an IP address', '203.0.113.7'],
    ['a name with a scheme', 'https://canary-rp.example'],
    ['a single label', 'canary'],
  ])('passkeys on with %s: a warning that names nothing', async (_name, rpId) => {
    const { deps } = await setup()
    await store(deps, android())
    passkeys(deps, true, rpId)
    const result = await Instance.diagnostics(deps)
    expect(byId(result.checks, 'native_app_passkeys')).toEqual({
      id: 'native_app_passkeys',
      status: 'warn',
      summary:
        'Passkeys are on in 1 environment with native apps where the relying party (`passkeys.rpId`) is not a domain a platform can associate with an app: it is not set, it is `localhost` or a loopback name, or it is no domain name. The apps there cannot use passkeys.',
      fix: `Set \`passkeys.rpId\` in those environments’ settings to the domain the apps name as their associated domain (changing it orphans the passkeys already registered). ${PROXY}`,
    })
    expectNothingNamed(result, deps)
  })

  test('it counts environments, apart for each finding, and only those with apps', async () => {
    const { deps } = await setup()
    const [off, local, fine, noApps] = addEnvironments(deps, 4)
    await store(deps, ios())
    await store(deps, ios(), off)
    await store(deps, ios(), local)
    await store(deps, ios(), fine)
    passkeys(deps, false, null, off)
    passkeys(deps, true, 'localhost', local)
    passkeys(deps, true, RP_ID, fine)
    // No app here: its relying party is nobody's business.
    passkeys(deps, true, 'localhost', noApps)
    const { passkeys: check } = await native(deps)
    expect(check.status).toBe('warn')
    expect(check.summary).toStartWith('Passkeys are on in 1 environment with native apps where')
    expect(check.summary).toEndWith(
      'The apps there cannot use passkeys. In 2 more with native apps, passkeys are switched off.'
    )
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
    expect(byId(result.checks, 'native_app_passkeys').status).toBe('warn')
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
          'Only the first 200 of 201 environments were looked at: none of them has a native app. The other 1 was not read.',
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
      'Only the first 200 of 201 environments were looked at. The 1 native app registered in 1 environment of the first 200 of 201 environments is well formed: each passes the rules a registration is held to. Whether a bundle ID, a team or a fingerprint is the one your app really has cannot be checked from here. The other 1 was not read.'
    )
    expect(some.files.status).toBe('warn')
    expect(some.files.summary).toStartWith('Only the first 200 of 201 environments were looked at.')
    expect(some.passkeys.status).toBe('warn')
    expect(some.passkeys.fix).toBe(
      'One run reads the native apps of the 200 oldest environments only. A newer environment’s apps were not checked.'
    )

    await store(deps, android(PACKAGE, []))
    expect((await native(deps)).identities.summary).toStartWith(
      '1 of the 2 native apps registered in 1 environment of the first 200 of 201 environments is not well formed'
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
    const { deps } = await setup()
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
})
