import { describe, expect, test } from 'bun:test'
import { ApiError, fieldErrorMap, isForbidden, messageFor, toApiError } from '~/api/errors'
import { auditQuery, auditSearch } from '~/features/audit/audit-log-screen'
import { maskedKey } from '~/features/keys/api-keys-screen'
import { numberOrNull, textOrNull, wholeNumber } from '~/features/settings/inputs'
import { ENVIRONMENT_SECTIONS, sectionOf } from '~/features/shell/sections'
import { syncScope, useScope } from '~/state/scope'
import { formatDateTime, fullName, isHttpsUrl, userLabel } from './format'
import { safeRedirect } from './redirect'
import { pageSearch } from './search'

describe('safeRedirect', () => {
  test('keeps a path of the app, with its search', () => {
    expect(safeRedirect('/w/1/p/2/e/3/users?q=ada')).toBe('/w/1/p/2/e/3/users?q=ada')
  })
  test.each([
    ['another host', '//evil.example/x'],
    ['an absolute URL', 'https://evil.example/x'],
    ['a backslash a browser reads as a slash', '/\\evil.example'],
    ['a control character', '/users\n/x'],
    ['the sign-in page itself', '/sign-in?redirect=/x'],
    ['a relative path', 'users'],
    ['not a string', 42],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(safeRedirect(value)).toBe('/')
  })
})

describe('search parameters', () => {
  test('page: whole numbers above one only', () => {
    expect(pageSearch({ page: 3 })).toEqual({ page: 3 })
    expect(pageSearch({ page: '4' })).toEqual({ page: 4 })
    expect(pageSearch({ page: 1 })).toEqual({})
    expect(pageSearch({ page: 'x' })).toEqual({})
    expect(pageSearch({ page: 2.5 })).toEqual({})
  })
  test('audit filters: only known keys of the expected shape survive', () => {
    expect(
      auditSearch({
        action: 'user.banned',
        actorType: 'instance_admin',
        actorId: '',
        targetId: 7,
        from: '2026-10-01',
        to: 'yesterday',
        page: 2,
        evil: '<script>',
      })
    ).toEqual({ action: 'user.banned', actorType: 'instance_admin', from: '2026-10-01', page: 2 })
    expect(auditSearch({ actorId: 'x'.repeat(201) })).toEqual({})
  })
  test('audit query: days become instants, the page defaults to one', () => {
    expect(
      auditQuery({ from: '2026-10-01', to: '2026-10-02', actorId: 'a', targetId: 't' })
    ).toEqual({
      actorId: 'a',
      targetId: 't',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T23:59:59.999Z',
      page: 1,
      size: 25,
    })
  })
})

describe('sections', () => {
  test('the screen is read from the address, defaulting to users', () => {
    expect(sectionOf('/w/1/p/2/e/3/api-keys').segment).toBe('api-keys')
    expect(sectionOf('/w/1/p/2/e/3/users/abc').segment).toBe('users')
    expect(sectionOf('/instance/diagnostics').segment).toBe('users')
    expect(sectionOf('/w/1/p/2/e/3/unknown').segment).toBe('users')
    expect(new Set(ENVIRONMENT_SECTIONS.map((section) => section.segment)).size).toBe(
      ENVIRONMENT_SECTIONS.length
    )
  })
})

describe('format', () => {
  test('times, names and links', () => {
    expect(formatDateTime(null)).toBe('Never')
    expect(formatDateTime(undefined, '—')).toBe('—')
    expect(formatDateTime('not a date', 'None')).toBe('None')
    expect(formatDateTime('2026-10-04T12:00:00.000Z')).toContain('2026')
    expect(fullName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace')
    expect(fullName({ firstName: null, lastName: null })).toBe('')
  })

  test.each([
    [{ email: 'ada@example.com', firstName: 'Ada', lastName: null }, 'ada@example.com'],
    [{ email: null, firstName: 'Nelly', lastName: 'Okafor' }, 'Nelly Okafor'],
    [{ email: null, firstName: null, lastName: null }, 'User u1'],
    [{ email: null, firstName: '', lastName: '' }, 'User u1'],
  ])('userLabel of %j is %j: the address, else the name, else the id', (user, label) => {
    expect(userLabel({ id: 'u1', ...user })).toBe(label)
    expect(isHttpsUrl('https://example.com/a')).toBe(true)
    expect(isHttpsUrl('http://example.com')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('not a url')).toBe(false)
  })
  test('settings inputs', () => {
    expect(wholeNumber('12')).toBe(12)
    expect(wholeNumber('')).toBe(0)
    expect(wholeNumber('abc')).toBe(0)
    expect(numberOrNull('')).toBeNull()
    expect(numberOrNull('7')).toBe(7)
    expect(numberOrNull('x')).toBeNull()
    expect(textOrNull('  ')).toBeNull()
    expect(textOrNull(' a ')).toBe('a')
  })
  test('a key is shown by its prefix and last four only', () => {
    expect(maskedKey({ kind: 'secret', lastFour: 'a1b2' })).toBe('tula_sk_…a1b2')
    expect(maskedKey({ kind: 'publishable', lastFour: 'c3d4' })).toBe('tula_pk_…c3d4')
  })
})

describe('errors', () => {
  const refused = new ApiError({
    status: 422,
    code: 'validation.failed',
    detail: 'Invalid.',
    fieldErrors: [
      { field: 'name', code: 'validation.failed', message: 'first' },
      { field: 'name', code: 'validation.failed', message: 'second' },
    ],
  })
  test('anything thrown becomes an ApiError that carries nothing of the original', () => {
    expect(toApiError(refused)).toBe(refused)
    const other = toApiError(new Error('connect to db.internal failed'))
    expect(other.code).toBe('client.failed')
    expect(other.message).not.toContain('db.internal')
  })
  test('the first message of a field wins', () => {
    expect(fieldErrorMap(refused)).toEqual({ name: 'first' })
    expect(fieldErrorMap(new Error('x'))).toEqual({})
  })
  test('messages: the dashboard’s own for a few codes, the server’s otherwise', () => {
    expect(messageFor(refused)).toBe('Invalid.')
    expect(
      messageFor(new ApiError({ status: 412, code: 'precondition.failed', detail: 'x' }))
    ).toContain('changed somewhere else')
    expect(messageFor(new ApiError({ status: 429, code: 'rate_limited', detail: 'x' }))).toContain(
      'Wait'
    )
    expect(
      messageFor(new ApiError({ status: 429, code: 'rate_limited', detail: 'x', retryAfter: 9 }))
    ).toContain('9 seconds')
  })
  test('403 is forbidden', () => {
    expect(isForbidden(new ApiError({ status: 403, code: 'x.y', detail: 'no' }))).toBe(true)
    expect(isForbidden(refused)).toBe(false)
  })
})

describe('syncScope', () => {
  function cache() {
    const removed: boolean[][] = []
    const keys = [['/v1/admin/users', { page: 1 }], ['/v1/instance/workspaces'], [42]]
    return {
      removed,
      removeQueries: ({
        predicate,
      }: {
        predicate: (query: { queryKey: readonly unknown[] }) => boolean
      }) => {
        removed.push(keys.map((queryKey) => predicate({ queryKey })))
      },
    }
  }
  test('a new environment drops every cached admin answer, and only those', () => {
    useScope.setState({ workspaceId: 'w', projectId: 'p', environmentId: 'e1' })
    const queries = cache()
    syncScope(queries, { workspaceId: 'w', projectId: 'p', environmentId: 'e2' })
    expect(queries.removed).toEqual([[true, false, false]])
    expect(useScope.getState().environmentId).toBe('e2')
  })
  test('the same environment keeps the cache and the store object', () => {
    useScope.setState({ workspaceId: 'w', projectId: 'p', environmentId: 'e1' })
    const before = useScope.getState()
    const queries = cache()
    syncScope(queries, { workspaceId: 'w', projectId: 'p', environmentId: 'e1' })
    expect(queries.removed).toEqual([])
    expect(useScope.getState()).toBe(before)
  })
  test('another project in the same store updates the selection', () => {
    useScope.setState({ workspaceId: 'w', projectId: 'p', environmentId: null })
    syncScope(cache(), { workspaceId: 'w', projectId: 'p2', environmentId: null })
    expect(useScope.getState().projectId).toBe('p2')
  })
})
