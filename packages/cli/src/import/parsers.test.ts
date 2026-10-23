import { describe, expect, test } from 'bun:test'
import { fixture } from '../testing/import-fixtures'
import { parseAuth0 } from './auth0'
import { parseBetterAuth } from './better-auth'
import { parseClerk } from './clerk'
import { parseFirebase, parseHashConfig } from './firebase'
import {
  fitMetadata,
  maskEmail,
  parseCsv,
  readHash,
  readRecords,
  standardBase64,
  usableEmail,
} from './formats'
import { parseSupabase } from './supabase'
import type { ParseInput } from './types'

const BCRYPT = /^\$2[ab]\$10\$/
const FIREBASE = {
  signerKey:
    'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
}

function input(text: string, extra: Partial<ParseInput> = {}): ParseInput {
  return { text, files: {}, allowPasswordless: false, ...extra }
}

describe('CSV and records', () => {
  test('quotes, doubled quotes, CRLF, a quoted newline and a byte order mark', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['two\nlines', ''],
    ])
  })

  test('an unclosed quote is an error that does not repeat the file', () => {
    expect(() => parseCsv('a,b\n"secret-value,1')).toThrow('never closed')
    expect(() => parseCsv('a,b\n"secret-value,1')).not.toThrow('secret-value')
  })

  test('a JSON array, a container, one object, NDJSON with a bad line, and CSV', () => {
    const options = { containers: ['users'], csv: true, label: 'The export' }
    expect(readRecords('[{"a":1},3]', options)).toEqual([{ a: 1 }, null])
    expect(readRecords('{"users":[{"a":1}]}', options)).toEqual([{ a: 1 }])
    expect(readRecords('{"a":1}', options)).toEqual([{ a: 1 }])
    expect(readRecords('{"a":1}\nnope\n\n{"a":2}\n', options)).toEqual([{ a: 1 }, null, { a: 2 }])
    expect(readRecords('a,b\n1,2\n', options)).toEqual([{ a: '1', b: '2' }])
    expect(readRecords('  \n', options)).toEqual([])
  })

  test('a file that is no form this reads is refused without its content', () => {
    expect(() =>
      readRecords('hello,world\n1,2', { containers: [], csv: false, label: 'The X' })
    ).toThrow('The X is not a JSON')
    expect(() => readRecords('[1, nope', { containers: [], csv: true, label: 'The X' })).toThrow(
      'The X is not a JSON'
    )
  })
})

describe('helpers', () => {
  test('maskEmail keeps one character and the last label of the domain', () => {
    expect(maskEmail('maya@northline.app')).toBe('m***@***.app')
    expect(maskEmail('a.b@c.example.co.uk')).toBe('a***@***.uk')
    expect(maskEmail('weird')).toBe('***')
    expect(maskEmail('x@localhost')).toBe('x***@***')
    expect(maskEmail(null)).toBe('(no address)')
    expect(maskEmail('maya@northline.app')).not.toContain('maya')
    expect(maskEmail('maya@northline.app')).not.toContain('northline')
  })

  test('usableEmail wants one @ with text on both sides and no space', () => {
    expect(usableEmail(' a@b.co ')).toBe('a@b.co')
    for (const bad of [
      '',
      'a',
      '@b.co',
      'a@',
      'a@@b',
      'a b@c.co',
      undefined,
      7,
      `${'a'.repeat(320)}@b.co`,
    ]) {
      expect(usableEmail(bad)).toBeUndefined()
    }
  })

  test('standardBase64 turns the URL-safe alphabet into the standard one', () => {
    expect(standardBase64('ab-_c=')).toBe('ab+/c=')
    expect(standardBase64('ab+/c=')).toBe('ab+/c=')
  })

  test('metadata that is empty is nothing, and over the limit is too large', () => {
    expect(fitMetadata({ a: undefined, b: null })).toBeUndefined()
    expect(fitMetadata({ a: { b: 1 } })).toEqual({ a: { b: 1 } })
    expect(fitMetadata({ blob: 'x'.repeat(4100) })).toBe('too_large')
    // The server counts about one more byte per ':' and ',' than the compact JSON has.
    expect(fitMetadata({ blob: Array.from({ length: 1100 }, (_, i) => i) })).toBe('too_large')
  })

  test('readHash tells the algorithms the server reads, and refuses scrypt and the rest', () => {
    const cases: [string, string][] = [
      ['$2b$10$abc', 'bcrypt'],
      ['$2a$12$abc', 'bcrypt'],
      ['$2y$10$abc', 'bcrypt'],
      ['$argon2id$v=19$m=19456,t=2,p=1$a$b', 'argon2id'],
      ['$argon2i$v=19$m=19456,t=2,p=1$a$b', 'argon2i'],
      ['pbkdf2_sha256$260000$salt$hash', 'pbkdf2_sha256'],
      ['$pbkdf2-sha256$i=600000$salt$hash', 'pbkdf2_sha256'],
    ]
    for (const [hash, algorithm] of cases) {
      expect(readHash(hash)).toEqual({ kind: 'password', password: { algorithm, hash } })
    }
    for (const hash of [
      '$argon2d$v=19$m=1,t=1,p=1$a$b',
      '5f4dcc3b5aa765d61d8327deb882cf99',
      '$1$salt$x',
    ]) {
      expect(readHash(hash)).toMatchObject({ kind: 'unsupported' })
    }
    const scrypt = readHash(`${'a'.repeat(32)}:${'b'.repeat(128)}`)
    expect(scrypt).toMatchObject({ kind: 'unsupported' })
    expect(JSON.stringify(scrypt)).toContain('scrypt')
  })
})

describe('Clerk', () => {
  test('the dashboard CSV: hashers, verified addresses, names, totp, a repeat, refusals', () => {
    const parsed = parseClerk(input(fixture('clerk-users.csv')))
    expect(parsed.rows).toHaveLength(6)
    const [maya, jon, priya, old, nobody, again] = parsed.rows
    expect(maya?.user).toEqual({
      email: 'maya@northline.app',
      emailVerified: true,
      name: 'Maya Chen',
      externalId: 'user_2aaa',
      metadata: { clerk: { username: 'maya' } },
      password: { algorithm: 'bcrypt', hash: expect.stringMatching(BCRYPT) },
    })
    expect(jon?.user?.password).toMatchObject({ algorithm: 'argon2id' })
    expect(jon?.user?.password?.hash).toContain('m=19456,t=2,p=1')
    expect(priya?.user).toMatchObject({ emailVerified: false })
    expect(priya?.user?.password).toBeUndefined()
    expect(old?.refusal).toMatchObject({ code: 'import.unsupported_algorithm' })
    expect(old?.user).toBeNull()
    expect(nobody?.refusal).toMatchObject({ code: 'email.invalid' })
    expect(again?.user?.email).toBe('Maya@Northline.app')
    expect(parsed.notes.join(' ')).toContain('1 user(s) had an authenticator app')
    expect(parsed.organizations).toEqual([])
  })

  test('the Backend API JSON: email_addresses, verification, metadata and banned', () => {
    const parsed = parseClerk(input(fixture('clerk-users.json')))
    expect(parsed.rows.map((row) => row.user?.email ?? row.refusal?.code)).toEqual([
      'maya@northline.app',
      'jon@northline.app',
      'source.user_disabled',
    ])
    expect(parsed.rows[0]?.user).toMatchObject({
      emailVerified: true,
      metadata: { clerk: { username: 'maya', publicMetadata: { plan: 'team' } } },
    })
    expect(parsed.rows[1]?.user?.emailVerified).toBe(false)
  })

  test('a Firebase-hashed Clerk user is refused, or imported without a password', () => {
    const csv =
      'id,primary_email_address,verified_email_addresses,password_digest,password_hasher\nu1,a@b.co,a@b.co,x,scrypt_firebase\n'
    expect(parseClerk(input(csv)).rows[0]?.refusal?.reason).toContain('Firebase')
    const lenient = parseClerk(input(csv, { allowPasswordless: true }))
    expect(lenient.rows[0]?.user).toEqual({
      email: 'a@b.co',
      emailVerified: true,
      externalId: 'u1',
    })
    expect(lenient.notes.join(' ')).toContain('without a password')
  })

  test('a digest with no hasher is read from its prefix', () => {
    const csv =
      'id,primary_email_address,password_digest\nu1,a@b.co,$2b$10$abcdefghijklmnopqrstuuvwxyz\n'
    expect(parseClerk(input(csv)).rows[0]?.user?.password?.algorithm).toBe('bcrypt')
  })

  test('organizations and memberships: slugs, roles and what is refused', () => {
    const parsed = parseClerk(
      input(fixture('clerk-users.csv'), {
        files: {
          organizations: fixture('clerk-organizations.json'),
          memberships: fixture('clerk-memberships.json'),
        },
      })
    )
    expect(
      parsed.organizations.map((org) => [org.sourceId, org.name, org.slug, org.refusal?.code])
    ).toEqual([
      ['org_2one', 'Northline Labs', 'northline-labs', undefined],
      ['org_2two', 'Okafor & Sons', 'okafor-sons', undefined],
      ['org_2bad', null, null, 'source.organization_invalid'],
    ])
    expect(
      parsed.memberships.map((m) => [m.organizationId, m.userId, m.role, m.refusal?.code])
    ).toEqual([
      ['org_2one', 'user_2aaa', 'admin', undefined],
      ['org_2one', 'user_2bbb', 'member', undefined],
      ['org_2two', 'user_2bbb', 'admin', undefined],
      ['org_2two', 'user_unknown', 'member', undefined],
      ['org_2two', '', null, 'source.membership_invalid'],
    ])
  })

  test('a name with accents and symbols becomes a Tula slug', () => {
    const parsed = parseClerk(
      input('id,primary_email_address\nu,a@b.co\n', {
        files: { organizations: '[{"id":"o","name":"Café Zoë & Co."}]' },
      })
    )
    expect(parsed.organizations[0]?.slug).toBe('cafe-zoe-co')
  })

  test('memberships without organizations are noted', () => {
    const parsed = parseClerk(
      input('id,primary_email_address\nu,a@b.co\n', {
        files: { memberships: '[{"organization_id":"o","user_id":"u","role":"org:admin"}]' },
      })
    )
    expect(parsed.notes.join(' ')).toContain('without an organizations file')
  })

  test('a line that is not an object is a refused row, not a failed run', () => {
    const parsed = parseClerk(input('{"id":"u","primary_email_address":"a@b.co"}\nnope\n'))
    expect(parsed.rows.map((row) => row.refusal?.code)).toEqual([
      undefined,
      'source.row_unreadable',
    ])
  })

  test('metadata over 4 KiB is dropped with a note and the user is kept', () => {
    const json = JSON.stringify([
      {
        id: 'u',
        email_addresses: [{ email_address: 'a@b.co' }],
        public_metadata: { blob: 'x'.repeat(5000) },
      },
    ])
    const parsed = parseClerk(input(json))
    expect(parsed.rows[0]?.user?.metadata).toBeUndefined()
    expect(parsed.notes.join(' ')).toContain('over the 4 KiB limit')
  })
})

describe('Auth0', () => {
  test('the user export alone: database users have no hash, and a note says why', () => {
    const parsed = parseAuth0(input(fixture('auth0-users.ndjson')))
    expect(parsed.rows).toHaveLength(7)
    expect(parsed.rows[0]?.user).toEqual({
      email: 'maya@northline.app',
      emailVerified: true,
      name: 'Maya Chen',
      externalId: 'auth0|64f1a0000000000000000001',
      metadata: { auth0: { userMetadata: { theme: 'dark' }, appMetadata: { plan: 'team' } } },
    })
    expect(parsed.rows[1]?.user?.name).toBe('Jon Okafor')
    expect(parsed.rows[3]?.user?.password).toMatchObject({ algorithm: 'bcrypt' })
    expect(parsed.rows[4]?.refusal?.code).toBe('source.user_disabled')
    expect(parsed.rows[5]?.refusal?.code).toBe('email.invalid')
    expect(parsed.rows[6]?.refusal?.code).toBe('source.row_unreadable')
    expect(parsed.notes.join(' ')).toContain('does not put password hashes')
  })

  test('the support hash export is joined by auth0|oid, and unmatched entries are noted', () => {
    const parsed = parseAuth0(
      input(fixture('auth0-users.ndjson'), {
        files: { 'password-hashes': fixture('auth0-password-hashes.ndjson') },
      })
    )
    expect(parsed.rows[0]?.user?.password).toEqual({
      algorithm: 'bcrypt',
      hash: expect.stringMatching(BCRYPT),
    })
    expect(parsed.rows[1]?.user?.password?.algorithm).toBe('bcrypt')
    expect(parsed.rows[2]?.user?.password).toBeUndefined()
    expect(parsed.notes.join(' ')).toContain('1 entry of the password hash file matched no user')
    expect(parsed.notes.join(' ')).not.toContain('does not put password hashes')
  })

  test('a hash is matched by address when the id does not match and only one entry has it', () => {
    const users = '{"user_id":"auth0|zzz","email":"a@b.co","email_verified":true}\n'
    const hashes =
      '{"_id":{"$oid":"other"},"email":"A@b.co","passwordHash":"$2b$10$abc"}\n' +
      '{"_id":{"$oid":"o2"},"email":"dup@b.co","passwordHash":"$2b$10$abc"}\n' +
      '{"_id":{"$oid":"o3"},"email":"dup@b.co","passwordHash":"$2b$10$def"}\n' +
      '{"_id":{"$oid":"o4"},"email":"nohash@b.co"}\n'
    const parsed = parseAuth0(input(users, { files: { 'password-hashes': hashes } }))
    expect(parsed.rows[0]?.user?.password?.hash).toBe('$2b$10$abc')
    expect(parsed.notes.join(' ')).toContain('2 entries of the password hash file matched no user')
    expect(parsed.notes.join(' ')).toContain(
      '1 line(s) of the password hash file had no readable passwordHash'
    )
    const ambiguous = parseAuth0(
      input('{"user_id":"auth0|q","email":"dup@b.co"}\n', { files: { 'password-hashes': hashes } })
    )
    expect(ambiguous.rows[0]?.user?.password).toBeUndefined()
    expect(ambiguous.notes.join(' ')).toContain('No password hash was matched')
  })

  test('an unknown hash format is refused, or imported without a password', () => {
    const users =
      '{"user_id":"auth0|a","email":"a@b.co","custom_password_hash":{"algorithm":"md5","hash":{"value":"x"}}}\n' +
      '{"user_id":"auth0|b","email":"b@b.co","custom_password_hash":{"algorithm":"bcrypt"}}\n' +
      '{"user_id":"auth0|c","email":"c@b.co","passwordHash":"plain"}\n'
    const strict = parseAuth0(input(users))
    expect(strict.rows.map((row) => row.refusal?.code)).toEqual([
      'import.unsupported_algorithm',
      'import.unsupported_algorithm',
      'import.unsupported_algorithm',
    ])
    const lenient = parseAuth0(input(users, { allowPasswordless: true }))
    expect(lenient.rows.every((row) => row.user !== null && row.user.password === undefined)).toBe(
      true
    )
  })

  test('a CSV is not an Auth0 export this reads', () => {
    expect(() => parseAuth0(input('Id,Email\n1,a@b.co\n'))).toThrow('The Auth0 export is not')
  })
})

describe('Firebase', () => {
  test('auth:export JSON: scrypt rows with URL-safe base64 converted, parameters once', () => {
    const parsed = parseFirebase(input(fixture('firebase-users.json'), { firebase: FIREBASE }))
    expect(parsed.rows).toHaveLength(5)
    const maya = parsed.rows[0]?.user
    expect(maya?.password).toEqual({
      algorithm: 'firebase_scrypt',
      hash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
      params: { salt: '42xEC+ixf3L2lw==' },
    })
    expect(maya).toMatchObject({
      email: 'maya@northline.app',
      emailVerified: true,
      name: 'Maya Chen',
    })
    expect(parsed.rows[1]?.refusal).toMatchObject({ code: 'import.hash_malformed' })
    expect(parsed.rows[1]?.refusal?.reason).toContain('no salt')
    expect(parsed.rows[2]?.user).toMatchObject({
      emailVerified: true,
      metadata: { firebase: { customAttributes: { role: 'editor' } } },
    })
    expect(parsed.rows[3]?.refusal?.code).toBe('source.user_disabled')
    expect(parsed.rows[4]?.refusal?.code).toBe('email.invalid')
    expect(parsed.firebaseScrypt).toEqual(FIREBASE)
  })

  test('without the parameters a hash cannot be carried: an error up front, or passwordless', () => {
    expect(() => parseFirebase(input(fixture('firebase-users.json')))).toThrow(
      '--firebase-hash-config'
    )
    const lenient = parseFirebase(
      input(fixture('firebase-users.json'), { allowPasswordless: true })
    )
    expect(lenient.rows[0]?.user?.password).toBeUndefined()
    expect(lenient.firebaseScrypt).toBeUndefined()
    expect(lenient.notes.join(' ')).toContain('without a password')
  })

  test('the parameters are not sent when no row uses them', () => {
    const parsed = parseFirebase(
      input('{"users":[{"localId":"a","email":"a@b.co"}]}', { firebase: FIREBASE })
    )
    expect(parsed.firebaseScrypt).toBeUndefined()
  })

  test('the hash config is read from JSON, from the console text, with camelCase, and refused without a key', () => {
    const expected = {
      signerKey: FIREBASE.signerKey,
      saltSeparator: 'Bw==',
      rounds: 8,
      memCost: 14,
    }
    expect(parseHashConfig(fixture('firebase-hash-config.json'))).toEqual(expected)
    expect(parseHashConfig(fixture('firebase-hash-config.txt'))).toEqual(expected)
    expect(
      parseHashConfig(
        JSON.stringify({ signerKey: 'abc-_', saltSeparator: 'Bw==', rounds: '8', memCost: 14 })
      )
    ).toEqual({ signerKey: 'abc+/', saltSeparator: 'Bw==', rounds: 8, memCost: 14 })
    expect(parseHashConfig('base64_signer_key: abcd').rounds).toBeUndefined()
    expect(() => parseHashConfig('rounds: 8')).toThrow('no base64_signer_key')
    expect(() => parseHashConfig('{"base64_signer_key": ""}')).toThrow('no base64_signer_key')
  })
})

describe('Supabase', () => {
  test('auth.users CSV: bcrypt, confirmation, names from metadata, deleted, banned, anonymous', () => {
    const parsed = parseSupabase(input(fixture('supabase-users.csv')), Date.parse('2025-01-01'))
    expect(parsed.rows).toHaveLength(7)
    expect(parsed.rows[0]?.user).toEqual({
      email: 'maya@northline.app',
      emailVerified: true,
      name: 'Maya Chen',
      externalId: '7d2c9f6e-0000-4000-8000-000000000001',
      metadata: {
        supabase: {
          userMetadata: { full_name: 'Maya Chen', avatar_url: 'https://example.com/m.png' },
          appMetadata: { provider: 'email', providers: ['email'] },
        },
      },
      password: { algorithm: 'bcrypt', hash: expect.stringMatching(/^\$2a\$10\$/) },
    })
    expect(parsed.rows[1]?.user).toMatchObject({ emailVerified: false, name: 'Jon Okafor' })
    expect(parsed.rows[2]?.user?.password).toBeUndefined()
    expect(parsed.rows[3]?.refusal?.code).toBe('source.user_deleted')
    expect(parsed.rows[4]?.refusal?.code).toBe('source.user_disabled')
    expect(parsed.rows[5]?.refusal).toMatchObject({ code: 'email.invalid' })
    expect(parsed.rows[5]?.refusal?.reason).toContain('anonymous')
    expect(parsed.rows[6]?.refusal?.code).toBe('import.unsupported_algorithm')
  })

  test('a ban that has ended does not refuse the user', () => {
    const csv = 'id,email,banned_until\nu,a@b.co,2020-01-01 00:00:00+00\n'
    expect(parseSupabase(input(csv), Date.parse('2025-01-01')).rows[0]?.user).not.toBeNull()
    expect(
      parseSupabase(input('id,email,banned_until\nu,a@b.co,garbage\n')).rows[0]?.refusal?.code
    ).toBe('source.user_disabled')
  })

  test('JSON and the default clock', () => {
    const parsed = parseSupabase(input(fixture('supabase-users.json')))
    expect(parsed.rows[0]?.user?.password?.algorithm).toBe('bcrypt')
  })

  test('--allow-passwordless carries a user whose hash is not readable', () => {
    const csv = 'id,email,encrypted_password\nu,a@b.co,5f4dcc3b5aa765d61d8327deb882cf99\n'
    const parsed = parseSupabase(input(csv, { allowPasswordless: true }))
    expect(parsed.rows[0]?.user?.password).toBeUndefined()
    expect(parsed.notes.join(' ')).toContain('without a password')
  })
})

describe('better-auth', () => {
  test('user and account tables as JSON: bcrypt and argon2 carried, scrypt refused, no-credential kept', () => {
    const parsed = parseBetterAuth(
      input(fixture('better-auth-user.json'), {
        files: { accounts: fixture('better-auth-account.json') },
      })
    )
    expect(parsed.rows.map((row) => row.user?.password?.algorithm ?? row.refusal?.code)).toEqual([
      'import.unsupported_algorithm',
      'argon2id',
      undefined,
      'bcrypt',
      'source.user_disabled',
    ])
    expect(parsed.rows[0]?.refusal?.reason).toContain('scrypt')
    expect(parsed.rows[2]?.user).toMatchObject({
      email: 'priya@northline.app',
      emailVerified: true,
    })
    expect(parsed.notes).toEqual([])
  })

  test('scrypt users are imported without a password with --allow-passwordless', () => {
    const parsed = parseBetterAuth(
      input(fixture('better-auth-user.json'), {
        files: { accounts: fixture('better-auth-account.json') },
        allowPasswordless: true,
      })
    )
    expect(parsed.rows[0]?.user).toMatchObject({ email: 'maya@northline.app' })
    expect(parsed.rows[0]?.user?.password).toBeUndefined()
    expect(parsed.notes.join(' ')).toContain('1 user(s) are imported without a password')
  })

  test('CSV tables and the note when no accounts file is given', () => {
    const withAccounts = parseBetterAuth(
      input(fixture('better-auth-user.csv'), {
        files: { accounts: fixture('better-auth-account.csv') },
      })
    )
    expect(
      withAccounts.rows.map((row) => row.user?.password?.algorithm ?? row.refusal?.code)
    ).toEqual(['import.unsupported_algorithm', 'bcrypt'])
    expect(withAccounts.rows[1]?.user?.emailVerified).toBe(true)
    const without = parseBetterAuth(input(fixture('better-auth-user.csv')))
    expect(without.rows.every((row) => row.user !== null && row.user.password === undefined)).toBe(
      true
    )
    expect(without.notes.join(' ')).toContain('No --accounts file')
  })

  test('snake_case columns are read too', () => {
    const parsed = parseBetterAuth(
      input('[{"id":"u","email":"a@b.co","email_verified":true}]', {
        files: { accounts: '[{"provider_id":"credential","user_id":"u","password":"$2b$10$abc"}]' },
      })
    )
    expect(parsed.rows[0]?.user).toMatchObject({ emailVerified: true })
    expect(parsed.rows[0]?.user?.password?.algorithm).toBe('bcrypt')
  })
})
