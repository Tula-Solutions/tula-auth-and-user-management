import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CAN_STILL_SIGN_IN_HEADER } from '@tula/contract/headers'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor, toApiError } from '~/api/errors'
import {
  type Session,
  type User,
  useBanUser,
  useDeleteUser,
  useGetUser,
  useGetUserAuthentication,
  useListAuditLogs,
  useListUserSessions,
  useResetUserFactors,
  useRevokeUserSession,
  useRevokeUserSessions,
  useSetUserPassword,
  useUnbanUser,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { DataTable } from '~/components/data-table'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader, Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime, fullName } from '~/lib/format'
import { SignInMethods } from './sign-in-methods'
import { type EnvironmentScope, UserStatus } from './users-screen'

/** What the reset of two-step verification left the user with. */
type ResetOutcome = 'can_sign_in' | 'locked_out'

type Confirmation =
  | { kind: 'ban' | 'unban' | 'delete' | 'reset-factors' | 'revoke-all' }
  | { kind: 'revoke'; session: Session }

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs font-medium text-muted-foreground'>{label}</dt>
      <dd className='text-sm break-words'>{children}</dd>
    </div>
  )
}

function SetPasswordDialog({
  user,
  open,
  onClose,
}: {
  user: User
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  // `gcTime: 0`: the query client must not keep the mutation (its variables hold the new
  // password) once this dialog has let go of it.
  const setPassword = useSetUserPassword({
    mutation: { gcTime: 0 },
    request: useEnvironmentRequest(),
  })
  const [password, setPasswordValue] = useState('')
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<string>()
  const production = environment.kind === 'production'

  useEffect(() => {
    if (!open) {
      // The new password is state only while this dialog is open.
      setPasswordValue('')
      setTyped('')
      setProblem(undefined)
    }
  }, [open])

  function close() {
    setPassword.reset()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (password === '') {
      setProblem('Enter the new password.')
      return
    }
    if (production && typed !== user.email) {
      return
    }
    setProblem(undefined)
    setPassword.mutate(
      { userId: user.id, data: { password } },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: [`/v1/admin/users/${user.id}/sessions`] }),
            queryClient.invalidateQueries({
              queryKey: [`/v1/admin/users/${user.id}/authentication`],
            }),
          ])
          notify('Password set')
          close()
        },
      }
    )
  }

  const failure = setPassword.error ? toApiError(setPassword.error) : null
  const policyErrors = failure?.fieldErrors.filter((entry) => entry.field === 'password') ?? []
  const fieldError = problem ?? fieldErrorMap(setPassword.error).password
  return (
    <Modal
      open={open}
      onClose={close}
      title={`Set a new password for ${user.email}?`}
      description='The current password stops working and every session of this user is ended. The user is told by email. Their existing password is never shown.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='New password'
          type='password'
          autoComplete='new-password'
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          error={policyErrors.length > 1 ? 'This password does not meet the policy.' : fieldError}
        />
        {policyErrors.length > 1 ? (
          <ul role='alert' className='list-disc pl-5 text-sm text-destructive'>
            {policyErrors.map((entry) => (
              <li key={`${entry.code}:${entry.message}`}>{entry.message}</li>
            ))}
          </ul>
        ) : null}
        {production ? (
          <TextField
            label={
              <>
                Type <span className='font-mono font-semibold'>{user.email}</span> to confirm
              </>
            }
            autoComplete='off'
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        ) : null}
        {failure && !fieldError && policyErrors.length === 0 ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(failure)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={close}>
            Cancel
          </ActionButton>
          <ActionButton
            type='submit'
            variant='destructive'
            pending={setPassword.isPending}
            aria-disabled={
              (production && typed !== user.email) || setPassword.isPending || undefined
            }
          >
            Set password
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

function Activity({ userId }: { userId: string }) {
  const activity = useListAuditLogs(
    { targetId: userId, page: 1, size: 10 },
    { request: useEnvironmentRequest() }
  )
  return (
    <Section
      title='Recent activity'
      description='The last ten audit entries about this user: sign-in methods linked, two-step verification and passkey changes, bans.'
    >
      <QueryState query={activity} label='Loading activity'>
        {(list) =>
          list.data.length === 0 ? (
            <p className='text-sm text-muted-foreground'>Nothing recorded yet.</p>
          ) : (
            <DataTable
              caption='Recent activity for this user'
              rows={list.data}
              rowKey={(entry) => entry.id}
              columns={[
                { header: 'When', cell: (entry) => formatDateTime(entry.occurredAt) },
                {
                  header: 'Action',
                  cell: (entry) => <code className='text-xs'>{entry.action}</code>,
                },
                { header: 'By', cell: (entry) => entry.actor.type },
              ]}
            />
          )
        }
      </QueryState>
    </Section>
  )
}

/** Props of {@link UserDetailScreen}. */
export interface UserDetailScreenProps {
  scope: EnvironmentScope
  userId: string
  /** Called after the user was deleted: there is nothing left to show here. */
  onGone: () => void
}

/**
 * One user: profile, state, sessions, and the actions an operator can take.
 *
 * Every action that cannot be taken back sits behind a confirmation that names the user, and
 * in a production environment asks for the email to be typed.
 *
 * @param props - See {@link UserDetailScreenProps}.
 * @returns The screen.
 */
export function UserDetailScreen({ scope, userId, onGone }: UserDetailScreenProps) {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const user = useGetUser(userId, { request })
  const sessions = useListUserSessions(userId, { request })
  const authentication = useGetUserAuthentication(userId, { request })
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [settingPassword, setSettingPassword] = useState(false)
  const [resetOutcome, setResetOutcome] = useState<ResetOutcome | null>(null)
  const ban = useBanUser({ request })
  const unban = useUnbanUser({ request })
  const remove = useDeleteUser({ request })
  const resetFactors = useResetUserFactors({
    request: {
      ...request,
      onResponse: (response) =>
        setResetOutcome(
          response.headers.get(CAN_STILL_SIGN_IN_HEADER) === 'false' ? 'locked_out' : 'can_sign_in'
        ),
    },
  })
  const revokeAll = useRevokeUserSessions({ request })
  const revokeOne = useRevokeUserSession({ request })
  const requireText = environment.kind === 'production' ? user.data?.email : undefined

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/v1/admin/users/${userId}`] }),
      queryClient.invalidateQueries({ queryKey: [`/v1/admin/users/${userId}/sessions`] }),
      queryClient.invalidateQueries({ queryKey: [`/v1/admin/users/${userId}/authentication`] }),
      queryClient.invalidateQueries({ queryKey: ['/v1/admin/audit-logs'] }),
      queryClient.invalidateQueries({ queryKey: ['/v1/admin/users'] }),
    ])
  }

  function done(message: string) {
    return async () => {
      await refresh()
      notify(message)
      setConfirmation(null)
    }
  }

  function closeConfirmation() {
    for (const mutation of [ban, unban, remove, resetFactors, revokeAll, revokeOne]) {
      mutation.reset()
    }
    setConfirmation(null)
  }

  function confirm() {
    if (confirmation === null) {
      return
    }
    switch (confirmation.kind) {
      case 'ban':
        return ban.mutate({ userId }, { onSuccess: done('User banned') })
      case 'unban':
        return unban.mutate({ userId }, { onSuccess: done('User unbanned') })
      case 'reset-factors':
        return resetFactors.mutate({ userId }, { onSuccess: done('Two-step verification reset') })
      case 'revoke-all':
        return revokeAll.mutate({ userId }, { onSuccess: done('All sessions revoked') })
      case 'revoke':
        return revokeOne.mutate(
          { userId, sessionId: confirmation.session.id },
          { onSuccess: done('Session revoked') }
        )
      case 'delete':
        return remove.mutate(
          { userId },
          {
            onSuccess: async () => {
              setConfirmation(null)
              notify('User deleted')
              await queryClient.invalidateQueries({ queryKey: ['/v1/admin/users'] })
              onGone()
            },
          }
        )
    }
  }

  const backLink = (
    <Link
      to='/w/$workspaceId/p/$projectId/e/$environmentId/users'
      params={scope}
      className='text-sm text-link underline underline-offset-4'
    >
      ← All users
    </Link>
  )

  return (
    <>
      {backLink}
      <QueryState query={user} label='Loading the user'>
        {(account) => {
          const dialogs: Record<
            Confirmation['kind'],
            {
              title: string
              body: ReactNode
              label: string
              pending: boolean
              error: unknown
              plain?: boolean
            }
          > = {
            ban: {
              title: `Ban ${account.email}?`,
              body: 'They are signed out everywhere and cannot sign in until unbanned. Their data is kept.',
              label: 'Ban user',
              pending: ban.isPending,
              error: ban.error,
            },
            unban: {
              title: `Unban ${account.email}?`,
              body: 'They can sign in again.',
              label: 'Unban user',
              pending: unban.isPending,
              error: unban.error,
              plain: true,
            },
            'reset-factors': {
              title: `Reset two-step verification for ${account.email}?`,
              body: (
                <>
                  Their authenticator app, backup codes and passkeys are all taken off the account,
                  and they are told by email. Use this when someone has lost their second factor.
                  {/* Said before the reset, from what the account has now; the answer's header
                      is still what the screen reports afterwards. Unknown (loading, failed) is
                      not a warning: the header covers it. */}
                  {authentication.data?.canSignInWithoutPasskeys === false ? (
                    <span className='mt-3 block rounded-lg border border-destructive bg-destructive-surface p-3 text-foreground'>
                      Warning: this user has no password, linked account or emailed code they can
                      use here. After the reset they will have no way left to sign in until you set
                      a password for them or switch on a method they can use.
                    </span>
                  ) : null}
                </>
              ),
              label: 'Reset two-step verification',
              pending: resetFactors.isPending,
              error: resetFactors.error,
            },
            'revoke-all': {
              title: `Revoke every session of ${account.email}?`,
              body: 'They are signed out on every device and must sign in again.',
              label: 'Revoke all sessions',
              pending: revokeAll.isPending,
              error: revokeAll.error,
            },
            revoke: {
              title: `Revoke this session of ${account.email}?`,
              body: 'That device is signed out within a minute; the others stay signed in.',
              label: 'Revoke session',
              pending: revokeOne.isPending,
              error: revokeOne.error,
            },
            delete: {
              title: `Delete ${account.email}?`,
              body: 'The account, its sessions and its sign-in methods are deleted for good. This cannot be undone.',
              label: 'Delete user',
              pending: remove.isPending,
              error: remove.error,
            },
          }
          const active = confirmation ? dialogs[confirmation.kind] : null
          return (
            <>
              <PageHeader title={account.email} description={fullName(account) || undefined} />
              {resetOutcome !== null ? (
                <p
                  role='alert'
                  className={
                    resetOutcome === 'locked_out'
                      ? 'rounded-lg border border-destructive bg-destructive-surface p-3 text-sm'
                      : 'rounded-lg border bg-card p-3 text-sm'
                  }
                >
                  {resetOutcome === 'locked_out'
                    ? 'Warning: two-step verification was reset, and this user now has no way left to sign in. Set a password for them, or they must use “Forgot password”.'
                    : 'Two-step verification was reset. The user can still sign in with what they have left.'}
                </p>
              ) : null}
              <Section title='Profile'>
                <dl className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                  <Detail label='Email'>{account.email}</Detail>
                  <Detail label='Name'>{fullName(account) || '—'}</Detail>
                  <Detail label='Status'>
                    <UserStatus user={account} />
                  </Detail>
                  <Detail label='Email verified'>
                    {formatDateTime(account.emailVerifiedAt, 'Not verified')}
                  </Detail>
                  <Detail label='Banned'>{formatDateTime(account.bannedAt, 'No')}</Detail>
                  <Detail label='Last sign-in'>{formatDateTime(account.lastSignInAt)}</Detail>
                  <Detail label='Created'>{formatDateTime(account.createdAt)}</Detail>
                  <Detail label='User id'>
                    <code className='text-xs'>{account.id}</code>
                  </Detail>
                </dl>
              </Section>

              <SignInMethods query={authentication} />

              <Section
                title='Sessions'
                description='Where this user is signed in now.'
                actions={
                  sessions.data && sessions.data.data.length > 0 ? (
                    <ActionButton
                      variant='outline'
                      size='sm'
                      onClick={() => setConfirmation({ kind: 'revoke-all' })}
                    >
                      Revoke all sessions
                    </ActionButton>
                  ) : null
                }
              >
                <QueryState query={sessions} label='Loading sessions'>
                  {(list) =>
                    list.data.length === 0 ? (
                      <EmptyState title='No active sessions'>
                        This user is not signed in anywhere.
                      </EmptyState>
                    ) : (
                      <DataTable
                        caption='Active sessions'
                        rows={list.data}
                        rowKey={(session) => session.id}
                        columns={[
                          { header: 'Client', cell: (session) => session.client },
                          { header: 'Device', cell: (session) => session.userAgent ?? 'Unknown' },
                          {
                            header: 'IP address',
                            cell: (session) => session.ipAddress ?? 'Unknown',
                          },
                          {
                            header: 'Signed in',
                            cell: (session) => formatDateTime(session.createdAt),
                          },
                          {
                            header: 'Last active',
                            cell: (session) => formatDateTime(session.lastActiveAt),
                          },
                          {
                            header: 'Actions',
                            cell: (session) => (
                              <ActionButton
                                variant='outline'
                                size='sm'
                                onClick={() => setConfirmation({ kind: 'revoke', session })}
                                aria-label={`Revoke the ${session.client} session signed in ${formatDateTime(session.createdAt)}`}
                              >
                                Revoke
                              </ActionButton>
                            ),
                          },
                        ]}
                      />
                    )
                  }
                </QueryState>
              </Section>

              <Activity userId={userId} />

              <Section title='Account actions' description='Each asks for confirmation first.'>
                <div className='flex flex-wrap gap-2'>
                  <ActionButton variant='outline' onClick={() => setSettingPassword(true)}>
                    Set password
                  </ActionButton>
                  <ActionButton
                    variant='outline'
                    onClick={() => setConfirmation({ kind: 'reset-factors' })}
                  >
                    Reset two-step verification
                  </ActionButton>
                  {account.bannedAt ? (
                    <ActionButton
                      variant='outline'
                      onClick={() => setConfirmation({ kind: 'unban' })}
                    >
                      Unban user
                    </ActionButton>
                  ) : (
                    <ActionButton
                      variant='outline'
                      onClick={() => setConfirmation({ kind: 'ban' })}
                    >
                      Ban user
                    </ActionButton>
                  )}
                  <ActionButton
                    variant='destructive'
                    onClick={() => setConfirmation({ kind: 'delete' })}
                  >
                    Delete user
                  </ActionButton>
                </div>
              </Section>

              <ConfirmDialog
                open={active !== null}
                title={active?.title ?? ''}
                confirmLabel={active?.label ?? ''}
                destructive={!active?.plain}
                requireText={active?.plain ? undefined : requireText}
                pending={active?.pending}
                error={active?.error}
                onConfirm={confirm}
                onCancel={closeConfirmation}
              >
                {active?.body}
              </ConfirmDialog>
              <SetPasswordDialog
                user={account}
                open={settingPassword}
                onClose={() => setSettingPassword(false)}
              />
            </>
          )
        }}
      </QueryState>
    </>
  )
}
