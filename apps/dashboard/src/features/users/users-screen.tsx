import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CreateUserRequestSchema } from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import { type User, useCreateUser, useListUsers } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { DataTable, Pagination } from '~/components/data-table'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { formatDateTime, fullName } from '~/lib/format'

/** How many users one page of the table holds. */
export const USERS_PAGE_SIZE = 20

/** The ids every link of an environment's screens needs. */
export interface EnvironmentScope {
  workspaceId: string
  projectId: string
  environmentId: string
}

/**
 * A user's state in words: verified or not, banned or not. Never colour alone.
 *
 * @param props - `user`: the user.
 * @returns The labels.
 */
export function UserStatus({ user }: { user: Pick<User, 'emailVerifiedAt' | 'bannedAt'> }) {
  return (
    <span className='inline-flex flex-wrap gap-1.5'>
      <span className='rounded-full border border-input px-2 py-0.5 text-xs font-medium'>
        {user.emailVerifiedAt ? 'Verified' : 'Unverified'}
      </span>
      {user.bannedAt ? (
        <span className='rounded-full border border-destructive bg-destructive-surface px-2 py-0.5 text-xs font-semibold text-destructive'>
          Banned
        </span>
      ) : null}
    </span>
  )
}

interface CreateUserForm {
  email: string
  firstName: string
  lastName: string
  password: string
  emailVerified: boolean
}

const EMPTY_FORM: CreateUserForm = {
  email: '',
  firstName: '',
  lastName: '',
  password: '',
  emailVerified: false,
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  // `gcTime: 0`: the mutation's variables may hold a password; see `close`.
  const create = useCreateUser({ mutation: { gcTime: 0 } })
  const [form, setForm] = useState(EMPTY_FORM)
  const [problems, setProblems] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) {
      // The typed password does not outlive the dialog.
      setForm(EMPTY_FORM)
      setProblems({})
    }
  }, [open])

  function close() {
    create.reset()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = CreateUserRequestSchema.safeParse({
      email: form.email.trim(),
      ...(form.firstName.trim() ? { firstName: form.firstName } : {}),
      ...(form.lastName.trim() ? { lastName: form.lastName } : {}),
      ...(form.password ? { password: form.password } : {}),
      emailVerified: form.emailVerified,
    })
    const found: Record<string, string> = {}
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        found[String(issue.path[0])] ??= issue.message
      }
    }
    if (form.email.trim() === '') {
      found.email = 'Enter an email address.'
    }
    setProblems(found)
    if (!parsed.success || Object.keys(found).length > 0) {
      return
    }
    create.mutate(
      { data: parsed.data },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: ['/v1/admin/users'] })
          notify('User created')
          close()
        },
      }
    )
  }

  const errors = { ...fieldErrorMap(create.error), ...problems }
  const known = ['email', 'firstName', 'lastName', 'password']
  const general = create.error && !known.some((field) => errors[field])
  return (
    <Modal
      open={open}
      onClose={close}
      title='Create user'
      description='The user can sign in at once. Without a password they sign in another way, or set one through “Forgot password”.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Email'
          type='email'
          autoComplete='off'
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          error={errors.email}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='First name (optional)'
            autoComplete='off'
            value={form.firstName}
            onChange={(event) => setForm({ ...form, firstName: event.target.value })}
            error={errors.firstName}
          />
          <TextField
            label='Last name (optional)'
            autoComplete='off'
            value={form.lastName}
            onChange={(event) => setForm({ ...form, lastName: event.target.value })}
            error={errors.lastName}
          />
        </div>
        <TextField
          label='Password (optional)'
          type='password'
          autoComplete='new-password'
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          error={errors.password}
          hint='Checked against this environment’s password policy.'
        />
        <div className='flex items-center gap-2'>
          <Checkbox
            id='create-user-verified'
            checked={form.emailVerified}
            onCheckedChange={(checked) => setForm({ ...form, emailVerified: checked === true })}
          />
          <Label htmlFor='create-user-verified'>Mark the email as verified</Label>
        </div>
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(create.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={close}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={create.isPending}>
            Create user
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/** Props of {@link UsersScreen}. */
export interface UsersScreenProps {
  /** Where the screen is, for the links to a user. */
  scope: EnvironmentScope
  /** The search text from the address. */
  q: string
  /** The page from the address. */
  page: number
  /** Put a new search or page in the address. */
  onSearch: (next: { q: string; page: number; replace?: boolean }) => void
}

/**
 * The users of an environment: search, a paged table and "create user".
 *
 * The search text and the page live in the address, so a result can be linked to and
 * survives a reload.
 *
 * @param props - See {@link UsersScreenProps}.
 * @returns The screen.
 */
export function UsersScreen({ scope, q, page, onSearch }: UsersScreenProps) {
  const [text, setText] = useState(q)
  const [creating, setCreating] = useState(false)
  const users = useListUsers({ ...(q ? { q } : {}), page, size: USERS_PAGE_SIZE })

  useEffect(() => {
    setText(q)
  }, [q])

  function submit(event: FormEvent) {
    event.preventDefault()
    onSearch({ q: text.trim(), page: 1 })
  }

  return (
    <>
      <PageHeader
        title='Users'
        description='Everyone with an account in this environment.'
        actions={<ActionButton onClick={() => setCreating(true)}>Create user</ActionButton>}
      />
      <search>
        <form onSubmit={submit} className='flex flex-wrap items-end gap-2'>
          <div className='flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-sm'>
            <Label htmlFor='user-search'>Search users</Label>
            <Input
              id='user-search'
              type='search'
              className='bg-field'
              placeholder='Email or name'
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <ActionButton type='submit' variant='outline'>
            Search
          </ActionButton>
          {q ? (
            <ActionButton variant='ghost' onClick={() => onSearch({ q: '', page: 1 })}>
              Clear
            </ActionButton>
          ) : null}
        </form>
      </search>
      <QueryState query={users} label='Loading users'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState title={q ? 'No user matches that search' : 'No users yet'}>
              {q
                ? 'Search looks in the email address and the name.'
                : 'Users appear here when they sign up, or when you create one.'}
            </EmptyState>
          ) : (
            <div className='flex flex-col gap-4 rounded-xl border bg-card p-2 sm:p-4'>
              <DataTable
                caption='Users'
                rows={list.data}
                rowKey={(user) => user.id}
                columns={[
                  {
                    header: 'Email',
                    cell: (user) => (
                      <Link
                        to='/w/$workspaceId/p/$projectId/e/$environmentId/users/$userId'
                        params={{ ...scope, userId: user.id }}
                        className='font-medium text-link underline underline-offset-4'
                      >
                        {user.email}
                      </Link>
                    ),
                  },
                  { header: 'Name', cell: (user) => fullName(user) || '—' },
                  { header: 'Status', cell: (user) => <UserStatus user={user} /> },
                  { header: 'Last sign-in', cell: (user) => formatDateTime(user.lastSignInAt) },
                  { header: 'Created', cell: (user) => formatDateTime(user.createdAt) },
                ]}
              />
              <div className='px-2'>
                <Pagination
                  label='Users'
                  meta={list.meta}
                  onPage={(next) => onSearch({ q, page: next })}
                />
              </div>
            </div>
          )
        }
      </QueryState>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
