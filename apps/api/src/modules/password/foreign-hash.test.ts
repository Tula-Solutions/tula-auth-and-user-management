import { describe, expect, test } from 'bun:test'
import * as Foreign from '~/modules/password/foreign-hash'
import { ARGON2I_REFERENCE, BCRYPT_PHP_COST_7 } from '~/testing/password-vectors'

const BCRYPT_10 = '$2b$10$3Hhd48CmKmSgTadOLiIBTODcq2jUOHUFRtLETxpkRMFfzlHXVF6mK'
const SALT = 'c29tZXNhbHQ'
const DIGEST = 'RdescudvJCsgt3ub+b+dWRWJTmaaJObG'
const argon = (kind: string, params: string, version = 19, salt = SALT, digest = DIGEST) =>
  `$${kind}$v=${version}$${params}$${salt}$${digest}`

describe('detect', () => {
  test.each([
    [BCRYPT_10, 'bcrypt'],
    [BCRYPT_PHP_COST_7.replace('$2y$', '$2a$'), 'bcrypt'],
    [ARGON2I_REFERENCE, 'argon2i'],
    [argon('argon2id', 'm=19456,t=2,p=1'), 'argon2id'],
    ['$argon2d$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$abc', null],
    ['$1$salt$hash', null],
    ['plain text', null],
  ])('%s is %s', (stored, expected) => {
    expect(Foreign.detect(stored)).toBe(expected as Foreign.ImportAlgorithm | null)
  })
})

describe('parse: what is accepted', () => {
  test.each([
    ['bcrypt', BCRYPT_10],
    ['bcrypt', BCRYPT_10.replace('$2b$', '$2a$')],
    ['bcrypt', BCRYPT_10.replace('$2b$', '$2y$')],
    ['bcrypt', BCRYPT_10.replace('$10$', '$14$')],
    ['argon2i', ARGON2I_REFERENCE],
    ['argon2id', argon('argon2id', 'm=19456,t=2,p=1')],
    ['argon2id', argon('argon2id', 'm=262144,t=10,p=8')],
  ])('%s: %s', (algorithm, hash) => {
    expect(Foreign.parse(algorithm, hash)).toEqual({ ok: true, algorithm } as Foreign.ParsedHash)
  })
})

describe('parse: what is refused, and why', () => {
  const refused = (algorithm: string, hash: string) => {
    const result = Foreign.parse(algorithm, hash)
    return result.ok ? 'accepted' : result.code
  }

  test('an algorithm this server does not read', () => {
    for (const algorithm of ['scrypt', 'argon2d', 'md5', 'BCRYPT', '']) {
      expect(refused(algorithm, BCRYPT_10)).toBe('import.unsupported_algorithm')
    }
  })

  test.each([
    ['not a hash at all', 'bcrypt', 'hunter2'],
    ['an empty hash', 'bcrypt', ''],
    ['a bcrypt hash that is too short', 'bcrypt', BCRYPT_10.slice(0, 50)],
    ['a bcrypt hash that is too long', 'bcrypt', `${BCRYPT_10}x`],
    ['the buggy $2x$ prefix', 'bcrypt', BCRYPT_10.replace('$2b$', '$2x$')],
    ['the bare $2$ prefix', 'bcrypt', BCRYPT_10.replace('$2b$', '$2$')],
    ['a bcrypt hash with a character outside its alphabet', 'bcrypt', BCRYPT_10.replace('3', '+')],
    ['a bcrypt hash declared as argon2id', 'argon2id', BCRYPT_10],
    ['an argon2 hash declared as bcrypt', 'bcrypt', ARGON2I_REFERENCE],
    ['an argon2i hash declared as argon2id', 'argon2id', ARGON2I_REFERENCE],
    ['an argon2 hash of an old version', 'argon2i', argon('argon2i', 'm=65536,t=2,p=1', 16)],
    [
      'an argon2 hash with a salt under 8 bytes',
      'argon2i',
      argon('argon2i', 'm=65536,t=2,p=1', 19, 'c2Fsd'),
    ],
    [
      'an argon2 hash with a digest under 16 bytes',
      'argon2i',
      argon('argon2i', 'm=65536,t=2,p=1', 19, SALT, 'abcdefghij'),
    ],
    [
      'an argon2 hash without its parameters',
      'argon2id',
      '$argon2id$v=19$c29tZXNhbHQ$RdescudvJCsgt3ub',
    ],
    ['an argon2 hash with parallelism 0', 'argon2id', argon('argon2id', 'm=65536,t=2,p=0')],
    [
      'an argon2 hash with less memory than its lanes need',
      'argon2id',
      argon('argon2id', 'm=16,t=2,p=4'),
    ],
  ])('%s is malformed', (_name, algorithm, hash) => {
    expect(refused(algorithm, hash)).toBe('import.hash_malformed')
  })

  test.each([
    ['bcrypt cost 9', 'bcrypt', BCRYPT_10.replace('$10$', '$09$')],
    ['bcrypt cost 4', 'bcrypt', BCRYPT_10.replace('$10$', '$04$')],
    ['the PHP example, cost 7', 'bcrypt', BCRYPT_PHP_COST_7],
    ['argon2id with 19455 KiB', 'argon2id', argon('argon2id', 'm=19455,t=2,p=1')],
    ['argon2id with 1 pass', 'argon2id', argon('argon2id', 'm=65536,t=1,p=1')],
    ['argon2i with 4 MiB', 'argon2i', argon('argon2i', 'm=4096,t=3,p=1')],
  ])('%s is below the floor', (_name, algorithm, hash) => {
    expect(refused(algorithm, hash)).toBe('import.hash_parameters_too_weak')
  })

  test.each([
    ['bcrypt cost 15', 'bcrypt', BCRYPT_10.replace('$10$', '$15$')],
    ['bcrypt cost 31', 'bcrypt', BCRYPT_10.replace('$10$', '$31$')],
    ['argon2id with 256 MiB and a KiB', 'argon2id', argon('argon2id', 'm=262145,t=2,p=1')],
    ['argon2id with 11 passes', 'argon2id', argon('argon2id', 'm=65536,t=11,p=1')],
    ['argon2id with 9 lanes', 'argon2id', argon('argon2id', 'm=65536,t=2,p=9')],
  ])('%s asks for too much', (_name, algorithm, hash) => {
    expect(refused(algorithm, hash)).toBe('import.hash_parameters_too_costly')
  })

  test('the floors are the ones the ADR names', () => {
    expect(Foreign.HASH_LIMITS.bcrypt.minCost).toBe(10)
    expect(Foreign.HASH_LIMITS.argon2.minMemoryKiB).toBe(19_456)
    expect(Foreign.HASH_LIMITS.argon2.minTime).toBe(2)
  })
})
