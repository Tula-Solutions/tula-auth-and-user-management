import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/api/errors'
import type { NativeApp } from '~/api/generated/api.gen'
import { nativeAppProblems, serverProblems } from './native-app-dialogs'
import {
  associationUrls,
  fingerprintsOf,
  identifierOf,
  identityOf,
  nativeAppMessageFor,
  platformLabel,
  wideningSentences,
} from './words'

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')
const STAMPS = {
  id: '00000000-0000-7000-8000-000000000001',
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z',
}
const ios = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' } as const
const android = {
  platform: 'android',
  packageName: 'com.example.app',
  sha256CertFingerprints: [AA],
} as const

describe('what the screen says of an app', () => {
  test('a platform has a name; one a later server knows is written out, never looked up', () => {
    expect(platformLabel('ios')).toBe('iOS')
    expect(platformLabel('android')).toBe('Android')
    expect(platformLabel('constructor')).toBe('constructor')
    expect(platformLabel('har‮mony')).not.toContain('‮')
  })

  test('an identifier is the bundle id or the package name, with nothing unseen in it', () => {
    expect(identifierOf({ ...STAMPS, ...ios })).toBe('com.example.app')
    expect(identifierOf({ ...STAMPS, ...android, sha256CertFingerprints: [AA] })).toBe(
      'com.example.app'
    )
    expect(identifierOf({ ...STAMPS, ...ios, bundleId: 'com.ex​ample' })).not.toContain('​')
    const later = { ...STAMPS, platform: 'harmony' } as unknown as NativeApp
    expect(identifierOf(later)).toBe('')
    expect(identityOf(later)).toBeNull()
  })

  test('fingerprints are read one per line, or between spaces and commas', () => {
    expect(fingerprintsOf(` ${AA}\n\n${BB}, ${AA}\t`)).toEqual([AA, BB, AA])
    expect(fingerprintsOf('  \n ')).toEqual([])
  })

  test('the two files are under the environment’s own path', () => {
    expect(associationUrls('https://auth.example.com', 'env/1')).toEqual({
      apple:
        'https://auth.example.com/v1/environments/env%2F1/.well-known/apple-app-site-association',
      android: 'https://auth.example.com/v1/environments/env%2F1/.well-known/assetlinks.json',
    })
  })
})

describe('what a change widens is the contract’s rule, in the screen’s words', () => {
  test.each([
    ['registering an iOS app', null, ios, /Apple fetches for this environment will name this app/],
    ['registering an Android app', null, android, /Android fetches for this environment/],
    ['another team', { ...ios, teamId: 'ZZZZZZZZZZ' }, ios, /under another team/],
    [
      'a gained fingerprint',
      android,
      { ...android, sha256CertFingerprints: [AA, BB] },
      /key of an added certificate/,
    ],
  ])('%s is one sentence', (_name, was, is, sentence) => {
    const said = wideningSentences(was, is)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(sentence)
  })

  test.each([
    ['a removal', ios, null],
    ['the same team', ios, ios],
    ['a fingerprint taken away', { ...android, sha256CertFingerprints: [AA, BB] }, android],
    [
      'the same fingerprints written another way',
      android,
      { ...android, sha256CertFingerprints: [AA.toLowerCase()] },
    ],
  ])('%s widens nothing', (_name, was, is) => {
    expect(wideningSentences(was, is)).toEqual([])
  })
})

describe('a refusal in words', () => {
  const conflict = (params?: Record<string, unknown>) =>
    new ApiError({ status: 409, code: 'resource.conflict', detail: 'Conflict.', params })

  test('a conflict means three things, told apart by what it carries and what was asked', () => {
    expect(nativeAppMessageFor(conflict({ max: 20 }), 'create')).toContain('already has 20')
    expect(nativeAppMessageFor(conflict(), 'create')).toContain('already has that app')
    expect(nativeAppMessageFor(conflict(), 'change')).toContain('changed elsewhere')
    // A cap that is not a number is not repeated.
    expect(nativeAppMessageFor(conflict({ max: '<b>' }), 'create')).not.toContain('<b>')
  })

  test('an app that is gone is said as that for a change; anything else is the server’s', () => {
    const gone = new ApiError({ status: 404, code: 'resource.not_found', detail: 'Not found.' })
    expect(nativeAppMessageFor(gone)).toContain('no longer exists')
    expect(nativeAppMessageFor(gone, 'create')).toBe('Not found.')
    const down = new ApiError({ status: 503, code: 'service.unavailable', detail: 'Down.' })
    expect(nativeAppMessageFor(down)).toBe('Down.')
  })

  test('the server’s field errors go on their field, a list entry’s on the list', () => {
    const invalid = new ApiError({
      status: 422,
      code: 'validation.failed',
      detail: 'The request is not valid.',
      fieldErrors: [
        { field: 'sha256CertFingerprints.1', code: 'validation.failed', message: 'Not one.' },
        { field: 'teamId', code: 'validation.failed', message: 'No team.' },
      ],
    })
    expect(serverProblems(invalid, 'change')).toEqual({
      sha256CertFingerprints: 'Not one.',
      teamId: 'No team.',
    })
    expect(serverProblems(undefined, 'create')).toEqual({})
    expect(serverProblems(conflict(), 'create')).toEqual({
      general: 'This environment already has that app. Close this and look at the list again.',
    })
  })

  test('a failed parse names the field, and the entry of a list', () => {
    expect(
      nativeAppProblems([
        { path: ['teamId'], message: 'Team.' },
        { path: ['teamId'], message: 'Second.' },
        { path: ['sha256CertFingerprints', 2], message: 'Not one.' },
        { path: [], message: 'Name at least one field to change.' },
      ])
    ).toEqual({
      teamId: 'Team.',
      sha256CertFingerprints: 'Entry 3: Not one.',
      general: 'Name at least one field to change.',
    })
    expect(
      nativeAppProblems([{ path: ['sha256CertFingerprints'], message: 'Too small' }])
        .sha256CertFingerprints
    ).toBe('Enter one to 10 fingerprints, each once.')
  })
})
