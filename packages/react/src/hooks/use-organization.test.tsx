import { describe, expect, test } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { accessToken } from '../../../core/src/testing/fakes'
import { TulaProvider } from '../context'
import { attempt, failure, json, ROUTE, sessionTokens, started, world } from '../testing/harness'
import {
  type UseOrganizationListResult,
  type UseOrganizationResult,
  useOrganization,
  useOrganizationList,
} from './use-organization'

const LIST = 'GET /v1/client/me/organizations'
const ACTIVE = 'PUT /v1/client/me/organizations/active'
const CREATE = 'POST /v1/client/me/organizations'
const A = '01980000-0000-7000-8000-00000000000a'
const B = '01980000-0000-7000-8000-00000000000b'

function organization(id: string, name: string, role: string, permissions: string[]) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    role,
    permissions,
    createdAt: '2030-01-01T00:00:00.000Z',
  }
}
const ACME = organization(A, 'Acme', 'billing_manager', ['org:billing:read', 'org:billing:write'])
const GLOBEX = organization(B, 'Globex', 'member', ['org:docs:read'])

function page(data: unknown[], activeOrganizationId: string | null) {
  return json(200, { data, activeOrganizationId, meta: { hasMore: false, nextCursor: null } })
}

/** A world whose session acts in organization A from the first refresh. */
function inOrganization(id: string | null = A) {
  const w = world({ signedIn: true })
  w.api.on(ROUTE.refresh, () =>
    json(
      200,
      sessionTokens('access_1', { accessToken: accessToken('t', 60, id ? { org_id: id } : {}) })
    )
  )
  return w
}

function probe() {
  const seen = {
    org: undefined as unknown as UseOrganizationResult,
    list: undefined as unknown as UseOrganizationListResult,
    orgs: [] as UseOrganizationResult[],
  }
  function Probe() {
    seen.org = useOrganization()
    seen.list = useOrganizationList()
    seen.orgs.push(seen.org)
    return null
  }
  return { seen, Probe }
}

describe('useOrganization', () => {
  test('with no active organization it is loaded at once, asks for nothing and grants nothing', async () => {
    const w = inOrganization(null)
    w.api.on(LIST, () => page([ACME], null))
    const { seen, Probe } = (() => {
      const seen = { org: undefined as unknown as UseOrganizationResult }
      return {
        seen,
        Probe() {
          seen.org = useOrganization()
          return null
        },
      }
    })()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.isLoaded).toBe(true))
    expect(seen.org.organizationId).toBeNull()
    expect(seen.org.organization).toBeNull()
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
    expect(seen.org.has({ role: 'billing_manager' })).toBe(false)
    expect(w.api.calls(LIST)).toHaveLength(0)
  })

  test('the active organization, its role and permissions come from one list shared by both hooks', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => page([GLOBEX, ACME], A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.isLoaded).toBe(true))
    expect(seen.org.organizationId).toBe(A)
    expect(seen.org.organization?.name).toBe('Acme')
    expect(seen.org.role).toBe('billing_manager')
    expect(seen.org.permissions).toEqual(['org:billing:read', 'org:billing:write'])
    expect(seen.list.organizations?.map((entry) => entry.name)).toEqual(['Globex', 'Acme'])
    expect(seen.list.activeOrganizationId).toBe(A)
    expect(w.api.calls(LIST)).toHaveLength(1)
  })

  test('has() is exact: no wildcard, no implication, no other role, no empty check', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => page([ACME], A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.isLoaded).toBe(true))
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(true)
    expect(seen.org.has({ role: 'billing_manager' })).toBe(true)
    for (const permission of ['org:billing:*', '*', 'org:billing', 'org:billing:delete', '']) {
      expect(seen.org.has({ permission })).toBe(false)
    }
    expect(seen.org.has({ role: 'admin' })).toBe(false)
    expect(seen.org.has({} as never)).toBe(false)
  })

  test('has() is false before the list has arrived', async () => {
    const w = inOrganization()
    let release: (response: Response) => void = () => undefined
    w.api.on(LIST, () => new Promise<Response>((resolve) => (release = resolve)))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.organizationId).toBe(A))
    expect(seen.org.isLoaded).toBe(false)
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
    await act(async () => release(page([ACME], A)))
    await waitFor(() => expect(seen.org.has({ permission: 'org:billing:read' })).toBe(true))
  })

  test('a failed list is an error and grants nothing', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => failure(403, 'organization.disabled'))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.error?.code).toBe('organization.disabled'))
    expect(seen.org.isLoaded).toBe(false)
    expect(seen.org.has({ role: 'billing_manager' })).toBe(false)
  })

  test('a membership that is gone from the list is no role, even though the token names it', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => page([GLOBEX], A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.isLoaded).toBe(true))
    expect(seen.org.organization).toBeNull()
    expect(seen.org.role).toBeNull()
    expect(seen.org.has({ permission: 'org:docs:read' })).toBe(false)
  })

  test.each([
    ['a wildcard', ['org:billing:*']],
    ['a key with a dot', ['billing.read']],
    ['more than 32 keys', Array.from({ length: 33 }, (_, i) => `org:a:b${i}`)],
  ])('permissions with %s are no role at all', async (_name, permissions) => {
    const w = inOrganization()
    w.api.on(LIST, () => page([organization(A, 'Acme', 'admin', permissions)], A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.isLoaded).toBe(true))
    expect(seen.org.role).toBeNull()
    expect(seen.org.permissions).toEqual([])
    expect(seen.org.has({ role: 'admin' })).toBe(false)
  })

  test('switching organization follows the new token without another list', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => page([ACME, GLOBEX], A))
    w.api.on(ACTIVE, () =>
      json(200, {
        sessionId: 'session_1',
        organizationId: B,
        accessToken: accessToken('b', 60, { org_id: B }),
        accessTokenExpiresAt: '2030-01-01T00:01:00.000Z',
      })
    )
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.isLoaded).toBe(true))
    await act(async () => {
      await seen.list.setActive(B)
    })
    await waitFor(() => expect(seen.org.organizationId).toBe(B))
    expect(seen.org.role).toBe('member')
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
    expect(seen.org.has({ permission: 'org:docs:read' })).toBe(true)
    expect(seen.list.activeOrganizationId).toBe(B)
    expect(w.api.calls(LIST)).toHaveLength(1)
  })

  test('a list that was asked for before a choice does not undo it', async () => {
    const w = inOrganization()
    let release: (response: Response) => void = () => undefined
    w.api.on(LIST, () => new Promise<Response>((resolve) => (release = resolve)))
    w.api.on(ACTIVE, () =>
      json(200, {
        sessionId: 'session_1',
        organizationId: B,
        accessToken: accessToken('b', 60, { org_id: B }),
        accessTokenExpiresAt: '2030-01-01T00:01:00.000Z',
      })
    )
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.isLoading).toBe(true))
    await act(async () => {
      await seen.list.setActive(B)
    })
    await act(async () => release(page([ACME, GLOBEX], A)))
    await waitFor(() => expect(seen.list.isLoaded).toBe(true))
    expect(seen.list.activeOrganizationId).toBe(B)
    expect(seen.org.organizationId).toBe(B)
  })

  test('creating an organization reloads the list and does not switch to it', async () => {
    const w = inOrganization()
    let created = false
    w.api.on(LIST, () => page(created ? [ACME, GLOBEX] : [ACME], A))
    w.api.on(CREATE, () => {
      created = true
      return json(201, GLOBEX)
    })
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.organizations).toHaveLength(1))
    await act(async () => {
      await seen.list.create({ name: 'Globex', slug: 'globex' })
    })
    await waitFor(() => expect(seen.list.organizations).toHaveLength(2))
    expect(seen.list.activeOrganizationId).toBe(A)
  })
})

describe('reload and server rendering', () => {
  test('reload() of either hook asks the server again', async () => {
    const w = inOrganization()
    let names = [ACME]
    w.api.on(LIST, () => page(names, A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.organizations).toHaveLength(1))
    names = [ACME, GLOBEX]
    await act(async () => {
      await seen.list.reload()
    })
    await waitFor(() => expect(seen.list.organizations).toHaveLength(2))
    names = [ACME]
    await act(async () => {
      await seen.org.reload()
    })
    await waitFor(() => expect(seen.list.organizations).toHaveLength(1))
    expect(w.api.calls(LIST)).toHaveLength(3)
  })

  test('markup rendered on a server holds no organization and grants nothing', () => {
    const w = inOrganization()
    const { seen, Probe } = probe()
    renderToString(
      <TulaProvider client={w.client}>
        <Probe />
      </TulaProvider>
    )
    expect(seen.org.isLoaded).toBe(false)
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
    expect(seen.list.organizations).toBeNull()
  })
})

describe('a result for an older session is never shown', () => {
  test('a list that arrives after another user signed in is dropped', async () => {
    const w = inOrganization()
    let first: (response: Response) => void = () => undefined
    let calls = 0
    w.api.on(LIST, () => {
      calls += 1
      return calls === 1 ? new Promise<Response>((resolve) => (first = resolve)) : page([GLOBEX], B)
    })
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.list.isLoading).toBe(true))
    const staleHas = seen.org.has

    await act(async () => {
      await w.client.session.signOut()
    })
    await waitFor(() => expect(seen.list.organizations).toBeNull())

    // Another user signs in, in an organization of their own.
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () =>
      attempt(
        'sign_in',
        { status: 'complete', userId: 'user_2', sessionId: 'session_2' },
        {
          session: sessionTokens('s2', {
            sessionId: 'session_2',
            accessToken: accessToken('s2', 60, { org_id: B }),
          }),
        }
      )
    )
    await act(async () => {
      const flow = await w.client.signIn.start({ identifier: 'lee@globex.test' })
      await flow.submitPassword({ password: 'correct horse battery staple' })
    })
    await waitFor(() => expect(seen.org.organizationId).toBe(B))
    await waitFor(() =>
      expect(seen.list.organizations?.map((entry) => entry.name)).toEqual(['Globex'])
    )

    // The first user's list now arrives, late.
    await act(async () => first(page([ACME], A)))
    expect(seen.list.organizations?.map((entry) => entry.name)).toEqual(['Globex'])
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
    // Nothing the first user's list said was ever drawn for the second.
    expect(
      seen.orgs.some((entry) => entry.organization?.id === A && entry.organizationId === B)
    ).toBe(false)
    // A `has` kept from the first session answers false: it is keyed to that session.
    expect(staleHas({ permission: 'org:docs:read' })).toBe(false)
  })

  test('a signed-out client has no organization, and its list is dropped', async () => {
    const w = inOrganization()
    w.api.on(LIST, () => page([ACME], A))
    const { seen, Probe } = probe()
    w.mount(<Probe />)
    await waitFor(() => expect(seen.org.isLoaded).toBe(true))
    await act(async () => {
      await w.client.session.signOut()
    })
    await waitFor(() => expect(seen.org.organizationId).toBeNull())
    expect(seen.org.isLoaded).toBe(false)
    expect(seen.list.organizations).toBeNull()
    expect(seen.org.has({ permission: 'org:billing:read' })).toBe(false)
  })
})
