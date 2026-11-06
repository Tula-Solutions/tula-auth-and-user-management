import { describe, expect, test } from 'bun:test'
import { defaultMessage, isTulaAdminError } from './errors'

describe('isTulaAdminError', () => {
  test('recognises an error of another copy of the package by its name, code and status', () => {
    const foreign = Object.assign(new Error('x'), {
      name: 'TulaAdminError',
      code: 'a.b',
      status: 400,
    })
    expect(isTulaAdminError(foreign)).toBe(true)
  })

  test('refuses what lacks the name, the code or the status, and what is not an error', () => {
    const named = (extra: object) =>
      Object.assign(new Error('x'), { name: 'TulaAdminError' }, extra)
    expect(isTulaAdminError(named({ status: 400 }))).toBe(false)
    expect(isTulaAdminError(named({ code: 'a.b' }))).toBe(false)
    expect(isTulaAdminError(new Error('x'))).toBe(false)
    expect(isTulaAdminError({ name: 'TulaAdminError', code: 'a.b', status: 400 })).toBe(false)
    expect(isTulaAdminError(null)).toBe(false)
  })
})

describe('defaultMessage', () => {
  test('reads the client’s table, then the contract’s, and knows no inherited name', () => {
    expect(defaultMessage('network.timeout')).toBe('The Tula API took too long to answer.')
    expect(defaultMessage('auth.forbidden')).toEqual(expect.any(String))
    expect(defaultMessage('not.a_code')).toBeUndefined()
    expect(defaultMessage('constructor')).toBeUndefined()
  })
})
