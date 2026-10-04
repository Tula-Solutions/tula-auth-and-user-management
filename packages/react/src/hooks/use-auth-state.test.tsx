import { describe, expect, test } from 'bun:test'
import type { AuthState, TulaClient } from '@tula/core'
import { renderToString } from 'react-dom/server'
import { useAuthState } from './use-auth-state'

function fakeClient(state: AuthState, serverState?: AuthState): TulaClient {
  return {
    state,
    ...(serverState && { serverState }),
    onChange: () => () => undefined,
  } as unknown as TulaClient
}

function Status({ client }: { client: TulaClient }) {
  const state = useAuthState(client)
  return <p>{state.status === 'signed-in' ? `signed-in:${state.sessionId}` : state.status}</p>
}

describe('useAuthState during server rendering', () => {
  test('a client with no server state renders as loading, whatever it already knows', () => {
    const client = fakeClient({ status: 'signed-in', sessionId: 's1', user: null })
    expect(renderToString(<Status client={client} />)).toContain('loading')
  })

  test('a client that carries the server’s state renders it', () => {
    const client = fakeClient(
      { status: 'loading' },
      { status: 'signed-in', sessionId: 's1', user: null }
    )
    expect(renderToString(<Status client={client} />)).toContain('signed-in:s1')
  })

  test('a server state of signed out renders signed out, not loading', () => {
    const client = fakeClient({ status: 'loading' }, { status: 'signed-out' })
    expect(renderToString(<Status client={client} />)).toContain('signed-out')
  })
})
