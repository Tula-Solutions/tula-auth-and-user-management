import { describe, expect, test } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describeError, describeMailFailure, errorReason } from '~/lib/safe-error'

const EMAIL = 'maya@northline.app'
const HASH = '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA'

/** What the Postgres driver throws: a message that can quote input, plus SQLSTATE fields. */
function driverError(message: string, fields: Record<string, string>): Error {
  return Object.assign(new Error(message), fields)
}

function failedInsert(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "tula"."users" ("id", "email", "secret") values ($1, $2, $3)',
    ['u1', EMAIL, HASH],
    driverError(`duplicate key value violates unique constraint "users_environment_email_key"`, {
      code: '23505',
      constraint: 'users_environment_email_key',
      table: 'users',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    })
  )
}

describe('describeError', () => {
  test('a failed query is described by its SQLSTATE and object names, never its values', () => {
    const described = describeError(failedInsert())
    expect(described).toMatchObject({
      name: 'DatabaseError',
      code: '23505',
      constraint: 'users_environment_email_key',
      table: 'users',
    })
    const text = JSON.stringify(described)
    for (const secret of [EMAIL, HASH, 'Failed query', 'params', 'northline', 'argon2']) {
      expect(text).not.toContain(secret)
    }
    expect(described.stack).toContain('    at ')
  })

  test('a driver message that quotes the input is dropped too', () => {
    const described = describeError(
      driverError(`invalid input syntax for type inet: "${EMAIL}"`, { code: '22P02' })
    )
    expect(described).toMatchObject({ name: 'DatabaseError', code: '22P02' })
    expect(JSON.stringify(described)).not.toContain(EMAIL)
  })

  test('a query error wrapped in other errors is still recognised', () => {
    const wrapped = new Error('could not create the user', {
      cause: new Error('transaction failed', { cause: failedInsert() }),
    })
    const text = JSON.stringify(describeError(wrapped))
    expect(text).toContain('23505')
    expect(text).not.toContain(EMAIL)
    expect(text).not.toContain(HASH)
  })

  test('a query error without a driver cause is still stripped', () => {
    const described = describeError(new DrizzleQueryError('select $1', [EMAIL]))
    expect(described.name).toBe('DatabaseError')
    expect(JSON.stringify(described)).not.toContain(EMAIL)
  })

  test('an ordinary error keeps its name, message and stack', () => {
    const described = describeError(new TypeError('profile is not a function'))
    expect(described).toMatchObject({ name: 'TypeError', message: 'profile is not a function' })
    expect(described.stack).toContain('TypeError: profile is not a function')
  })

  test('a system error code such as EPIPE is not mistaken for a database error', () => {
    for (const code of ['EPIPE', 'EPERM', 'EBUSY', 'ETIME']) {
      const described = describeError(Object.assign(new Error(`write ${code}`), { code }))
      expect(described).toMatchObject({ name: 'Error', message: `write ${code}` })
    }
    // Postgres classes that start with a letter are still recognised.
    expect(describeError(Object.assign(new Error('x'), { code: 'P0001' })).name).toBe(
      'DatabaseError'
    )
    expect(describeError(Object.assign(new Error('x'), { code: 'XX000' })).name).toBe(
      'DatabaseError'
    )
  })

  test('something that is not an error is described as text', () => {
    expect(describeError('offline')).toEqual({ name: 'NonError', message: 'offline' })
    expect(describeError(undefined)).toEqual({ name: 'NonError', message: 'undefined' })
  })

  test('a cause chain that loops does not hang', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    first.cause = second
    expect(describeError(first).message).toBe('first')
  })
})

describe('errorReason', () => {
  test('is one line: the SQLSTATE for a database error, the message otherwise', () => {
    expect(errorReason(failedInsert())).toBe('database error 23505')
    expect(errorReason(new DrizzleQueryError('select $1', [EMAIL]))).toBe('database error')
    expect(errorReason(new Error('socket hang up'))).toBe('socket hang up')
    expect(errorReason('offline')).toBe('offline')
  })
})

describe('describeMailFailure', () => {
  test('keeps the name, the code and the SMTP status, never the message', () => {
    const rejected = Object.assign(new Error(`550 <${EMAIL}>: recipient rejected`), {
      code: 'EENVELOPE',
      responseCode: 550,
      response: `550 <${EMAIL}>`,
    })
    expect(describeMailFailure(rejected)).toBe('Error EENVELOPE 550')
    expect(describeMailFailure(new TypeError(EMAIL))).toBe('TypeError')
  })

  test.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['a string', EMAIL],
    ['an object with other fields', { message: EMAIL, name: { nested: EMAIL } }],
  ])('%s yields no text at all', (_, thrown) => {
    expect(describeMailFailure(thrown)).toBe('')
  })
})
