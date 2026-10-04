import { describe, expect, test } from 'bun:test'
import { type AdminClient, OPERATIONS } from '@tula/admin'
import { READ_OPERATIONS, readOnlyAdmin } from './read-only'
import { fakeAdmin, TEST_USER_ID } from './testing/fake-api'

describe('the read-only facade', () => {
  test('every allow-listed operation is a GET', () => {
    expect(READ_OPERATIONS.length).toBeGreaterThan(0)
    for (const id of READ_OPERATIONS) {
      expect(OPERATIONS[id].method).toBe('GET')
    }
  })

  test('the allow-list is exactly what the tools need: no key listing, no signing keys', () => {
    expect([...READ_OPERATIONS].sort()).toEqual([
      'getEnvironmentSettings',
      'getUser',
      'getUserAuthentication',
      'listAuditLogs',
      'listOAuthProviders',
      'listUserSessions',
      'listUsers',
    ])
  })

  test('an allow-listed read reaches the API as a GET with a timeout', async () => {
    const { admin, requests } = fakeAdmin()
    const users = await readOnlyAdmin(admin).read('getUser', { params: { userId: TEST_USER_ID } })
    expect(users.email).toBe('maya@example.com')
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /v1/admin/users/${TEST_USER_ID}`,
    ])
  })

  test.each([
    'deleteUser',
    'banUser',
    'replaceEnvironmentSettings',
    'createApiKey',
    'listApiKeys',
    'listSigningKeys',
    'verifySession',
    'constructor',
    '__proto__',
  ])('%s is refused at run time and nothing is sent', async (id) => {
    const { admin, requests } = fakeAdmin()
    const facade = readOnlyAdmin(admin)
    // The type refuses it too; the cast is what a mistake in a tool would look like.
    const read = facade.read as unknown as (id: string, input?: unknown) => Promise<unknown>
    await expect(read(id, { params: { userId: TEST_USER_ID } })).rejects.toThrow(
      'not a read operation'
    )
    expect(requests).toEqual([])
  })

  test('the facade exposes nothing but `read`: the client and its `call` are not reachable', () => {
    const { admin } = fakeAdmin()
    const facade = readOnlyAdmin(admin)
    expect(Object.keys(facade)).toEqual(['read'])
    expect((facade as unknown as { call?: unknown }).call).toBeUndefined()
    expect(Object.isFrozen(facade)).toBe(true)
  })

  test('an operation table in which an allow-listed id is not a GET is refused when the facade is made', () => {
    const { admin } = fakeAdmin()
    expect(() =>
      readOnlyAdmin(admin, { ...OPERATIONS, getUser: { method: 'DELETE', path: '/v1/admin/x' } })
    ).toThrow('getUser')
  })

  test('the type of `read` refuses an operation that is not on the allow-list', async () => {
    const { admin, requests } = fakeAdmin()
    const facade = readOnlyAdmin(admin)
    // @ts-expect-error deleteUser is not a read operation
    await expect(facade.read('deleteUser', { params: { userId: TEST_USER_ID } })).rejects.toThrow()
    // @ts-expect-error listApiKeys is a GET, and still not on the allow-list
    await expect(facade.read('listApiKeys')).rejects.toThrow()
    // @ts-expect-error a read takes no body
    await facade.read('getEnvironmentSettings', { body: {} })
    expect(requests.map((request) => request.method)).toEqual(['GET'])
  })

  test('each read carries the facade’s timeout', async () => {
    const seen: unknown[] = []
    const admin = {
      call: async (_id: string, input: unknown) => {
        seen.push(input)
        return { data: {}, status: 200, etag: null, date: null }
      },
    } as unknown as AdminClient
    await readOnlyAdmin(admin, OPERATIONS, 1234).read('getEnvironmentSettings')
    expect(seen).toEqual([{ timeoutMs: 1234 }])
  })
})
