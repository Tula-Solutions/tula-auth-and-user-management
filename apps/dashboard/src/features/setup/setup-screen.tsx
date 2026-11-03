import { useCallback, useEffect, useState } from 'react'
import { messageFor, toApiError } from '~/api/errors'
import type { SetupPortal } from '~/api/generated/api.gen'
import { PageHeader } from '~/components/page'
import { LoadingState } from '~/components/states'
import { printableName } from '~/lib/printable'
import { ConnectionForm, ServiceProviderValues } from './connection-form'
import { GroupRoles } from './group-roles'
import { ScimToken } from './scim-token'
import { boot, SETUP_TEST_CHANNEL, setupRequest } from './setup-api'
import { TestAndActivate } from './test-activate'

/**
 * The public single sign-on setup page an organization's IT administrator opens from a setup
 * link (ADR 0067, "Setup links"). It has no account: every call carries the link's token, held
 * in memory, and reaches nothing but that organization's connections.
 *
 * @returns The page.
 */
export function SetupScreen() {
  const [state] = useState(() => boot())
  const [portal, setPortal] = useState<SetupPortal | null>(null)
  const [failure, setFailure] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      setPortal(await setupRequest<SetupPortal>(''))
      setFailure(null)
    } catch (error) {
      setFailure(error)
    }
  }, [])

  useEffect(() => {
    if (state.token !== null) {
      void load()
    }
  }, [state.token, load])

  // The window the identity provider sent the person back to: tell the setup tab and step aside.
  useEffect(() => {
    if (state.token !== null || state.test === null) {
      return
    }
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.postMessage({ testId: state.test })
    channel.close()
    window.close()
  }, [state])

  if (state.token === null && state.test !== null) {
    return (
      <Shell>
        <PageHeader
          title='Test sign-in finished'
          description='Return to the setup tab: it shows the result. You can close this window.'
        />
      </Shell>
    )
  }
  if (
    state.token === null ||
    (failure !== null && toApiError(failure).code === 'auth.invalid_key')
  ) {
    return (
      <Shell>
        <PageHeader
          title='This setup link is not valid'
          description='It may have expired or been revoked, or the address is incomplete. Ask the person who sent it for a new link.'
        />
      </Shell>
    )
  }
  if (portal === null) {
    return (
      <Shell>
        {failure === null ? (
          <LoadingState label='Loading the setup page' />
        ) : (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(failure)}
          </p>
        )}
      </Shell>
    )
  }
  return (
    <Shell>
      <PageHeader
        title={`Set up single sign-on for ${printableName(portal.organization.name)}`}
        description='Connect your identity provider so that your people sign in with it. Nothing changes for them until you activate the connection, and password sign-in keeps working for the people who have a password.'
      />
      <Setup portal={portal} reload={load} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className='mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10'>
      {children}
    </main>
  )
}

function Setup({ portal, reload }: { portal: SetupPortal; reload: () => Promise<void> }) {
  const connection = portal.connections[0] ?? null
  return (
    <>
      <p className='text-sm text-muted-foreground'>
        This link works until{' '}
        <time dateTime={portal.expiresAt}>{new Date(portal.expiresAt).toUTCString()}</time>.
      </p>
      <ConnectionForm
        key={connection?.id ?? 'new'}
        portal={portal}
        connection={connection}
        reload={reload}
      />
      {connection ? (
        <>
          <ServiceProviderValues connection={connection} />
          <GroupRoles connection={connection} />
          <TestAndActivate connection={connection} reload={reload} />
        </>
      ) : null}
      <ScimToken />
    </>
  )
}
