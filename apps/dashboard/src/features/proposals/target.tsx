import type { ReactNode } from 'react'
import { toApiError } from '~/api/errors'
import {
  type ProposalTarget,
  useGetSession,
  useGetUser,
  useListOAuthProviders,
} from '~/api/generated/api.gen'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime, fullName } from '~/lib/format'
import { printable, unseenCodePoints } from '~/lib/printable'
import { targetWord } from './words'

// Who or what a proposal is about, read with the operator's own session, for the eye only:
// an agent's account of a target ("a stale session") is a claim, and the id alone gives a
// person nothing to check it against. These reads touch neither the proposal nor the target.
// What could not be read is said in fixed words beside the bare id, never guessed, and
// nothing of a failure's own text is shown. Everything from the server is a text node.

/** An id from the server, written so that it can be checked by eye. */
function Id({ id }: { id: string }) {
  return (
    <bdi dir='ltr' className='font-mono break-all'>
      {printable(id)}
    </bdi>
  )
}

/**
 * Text a user chose (a name), as text. Where it holds what a reader cannot see it is written
 * out character by character instead, as an address is.
 */
function Chosen({ text }: { text: string }) {
  return <bdi>{unseenCodePoints(text).length > 0 ? printable(text) : text}</bdi>
}

function isMissing(error: unknown): boolean {
  return toApiError(error).code === 'resource.not_found'
}

/** A user's address and name, or that it has none; the server's text, as text. */
function UserWords({
  user,
}: {
  user: { email?: string | null; firstName: string | null; lastName: string | null }
}) {
  const name = fullName(user)
  return (
    <>
      {user.email ? <Id id={user.email} /> : 'no email address'}
      {name ? (
        <>
          , <Chosen text={name} />
        </>
      ) : null}
    </>
  )
}

/**
 * The line. `read` says whether the target itself has been read (`data-read`): the question
 * before an approval keeps the line as it was when it was opened, and says when that was
 * before anything was known.
 */
function Line({ read, children }: { read: boolean; children: ReactNode }) {
  return (
    <span data-testid='proposal-target' data-read={read} className='break-words'>
      {children}
    </span>
  )
}

function UserTarget({ id }: { id: string }) {
  const user = useGetUser(id, { request: useEnvironmentRequest() })
  let state: ReactNode = 'reading the user…'
  if (user.data) {
    state = (
      <>
        <UserWords user={user.data} />
        {user.data.bannedAt ? '; banned now' : '; not banned now'}
      </>
    )
  } else if (user.error) {
    state = isMissing(user.error) ? 'no such user now' : 'the user could not be read'
  }
  return (
    <Line read={user.data !== undefined}>
      user <Id id={id} /> ({state})
    </Line>
  )
}

function SessionOwner({ userId }: { userId: string }) {
  const user = useGetUser(userId, { request: useEnvironmentRequest() })
  if (user.data) {
    return <UserWords user={user.data} />
  }
  if (user.error) {
    return <>{isMissing(user.error) ? 'no such user now' : 'the user could not be read'}</>
  }
  return <>reading the user…</>
}

function SessionTarget({ id }: { id: string }) {
  const session = useGetSession(id, { request: useEnvironmentRequest() })
  let state: ReactNode = 'reading the session…'
  if (session.data) {
    // Of the device only its kind: a user agent is text the session's holder chose.
    state = (
      <>
        of user <Id id={session.data.userId} />: <SessionOwner userId={session.data.userId} />;{' '}
        {printable(session.data.client)} client, signed in{' '}
        {formatDateTime(session.data.createdAt, 'at an unknown time')};{' '}
        {session.data.active === true ? 'live now' : 'already ended'}
      </>
    )
  } else if (session.error) {
    state = isMissing(session.error) ? 'no such session now' : 'could not be read'
  }
  return (
    <Line read={session.data !== undefined}>
      session <Id id={id} /> ({state})
    </Line>
  )
}

function ProviderTarget({ id }: { id: string }) {
  const providers = useListOAuthProviders({ request: useEnvironmentRequest() })
  let state = 'reading the provider…'
  if (providers.data) {
    const found = providers.data.data.find((one) => one.provider === id)
    if (!found?.configured) {
      state = 'not configured now'
    } else {
      state = found.enabled ? 'on now' : 'already off'
    }
  } else if (providers.error) {
    state = 'could not be read'
  }
  return (
    <Line read={providers.data !== undefined}>
      provider <Id id={id} /> ({state})
    </Line>
  )
}

/**
 * What a proposal would act on, as the environment has it now: a user's address and whether
 * they are banned, a session's owner and whether it is live, a provider and whether it is on.
 * A kind of target this version does not know is named by its id and nothing more.
 *
 * @param props - `target`: the proposal's target.
 * @returns One line of text.
 */
export function TargetDescription({ target }: { target: ProposalTarget }) {
  const type = String(target.type)
  if (type === 'user') {
    return <UserTarget id={target.id} />
  }
  if (type === 'session') {
    return <SessionTarget id={target.id} />
  }
  if (type === 'oauth_provider') {
    return <ProviderTarget id={target.id} />
  }
  return (
    <Line read>
      {targetWord(type)} <Id id={target.id} />
    </Line>
  )
}
