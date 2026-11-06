import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CreateOrganizationRequestSchema } from '@tula-tech/contract'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type Organization,
  useCreateOrganization,
  useListOrganizations,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { DataTable, Pagination } from '~/components/data-table'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader } from '~/components/page'
import { EmptyState } from '~/components/states'
import { notify } from '~/components/toaster'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { EnvironmentLink } from '~/features/shell/environment-link'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'
import { OrganizationsQueryState } from './organizations-gate'
import { refreshOrganizations } from './queries'
import { organizationMessageFor, slugFromName } from './words'

/** How many organizations one page of the table holds. */
export const ORGANIZATIONS_PAGE_SIZE = 20

/**
 * How long the search waits after the last key before it asks the API, in milliseconds. Each
 * request is a count and a page over the whole environment, and a word typed is not a word
 * until its last letter.
 */
export const ORGANIZATIONS_SEARCH_DEBOUNCE_MS = 300

function CreateOrganizationDialog({
  open,
  scope,
  onClose,
}: {
  open: boolean
  scope: EnvironmentScope
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const create = useCreateOrganization({ request: useEnvironmentRequest() })
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // Once the operator types a slug, the name stops writing it.
  const [slugTouched, setSlugTouched] = useState(false)
  const [problems, setProblems] = useState<Record<string, string>>({})
  // From the click until the dialog closes, which is after the list was read again: the
  // request has succeeded before that, and a live button would send it a second time.
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<Organization | null>(null)
  const { reset } = create

  useEffect(() => {
    if (!open) {
      setName('')
      setSlug('')
      setSlugTouched(false)
      setProblems({})
      setSaving(false)
      setCreated(null)
      reset()
    }
  }, [open, reset])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const parsed = CreateOrganizationRequestSchema.safeParse({ name, slug })
    if (!parsed.success) {
      const found: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        found[String(issue.path[0])] ??= issue.message
      }
      setProblems(found)
      return
    }
    setProblems({})
    setSaving(true)
    create.mutate(
      { data: parsed.data },
      {
        onError: () => setSaving(false),
        onSuccess: async (organization) => {
          await refreshOrganizations(queryClient)
          notify('Organization created')
          setCreated(organization)
        },
      }
    )
  }

  const errors = { ...fieldErrorMap(create.error), ...problems }
  const general = create.error && !errors.name && !errors.slug
  if (created !== null) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Organization created'
        description='It has no members yet. Open it to add the first one, or invite someone by email.'
        footer={
          <>
            <ActionButton variant='outline' onClick={onClose}>
              Close
            </ActionButton>
            <Link
              to='/w/$workspaceId/p/$projectId/e/$environmentId/organizations/$organizationId'
              params={{ ...scope, organizationId: created.id }}
              className='inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground'
            >
              Open organization
            </Link>
          </>
        }
      />
    )
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title='Create organization'
      description='An organization is a company, team or workspace your users belong to. It starts with no members.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (!slugTouched) {
              setSlug(slugFromName(event.target.value))
            }
          }}
          error={errors.name}
        />
        <TextField
          label='Slug'
          autoComplete='off'
          autoCapitalize='off'
          spellCheck={false}
          value={slug}
          onChange={(event) => {
            setSlugTouched(true)
            setSlug(event.target.value)
          }}
          error={errors.slug}
          hint='Lower-case letters and digits joined by hyphens, such as acme-corp. It goes into URLs and is unique in this environment.'
        />
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {organizationMessageFor(create.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            Create organization
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}

/** Props of {@link OrganizationsScreen}. */
export interface OrganizationsScreenProps {
  /** Where the screen is, for the links to an organization. */
  scope: EnvironmentScope
  /** The search text from the address. */
  q: string
  /** The page from the address. */
  page: number
  /** Put a new search or page in the address. */
  onSearch: (next: { q: string; page: number; replace?: boolean }) => void
}

/**
 * The organizations of an environment: a search, a paged table and "create organization".
 *
 * The search text and the page live in the address. The API does the search (the start of a
 * name or of a slug, ignoring case) over every organization of the environment, so a match is
 * found on whatever page it would be, and the table pages the matches. Typing sends it after
 * a short pause, replacing the address's entry rather than adding one for each pause;
 * "Search" sends it at once.
 *
 * @param props - See {@link OrganizationsScreenProps}.
 * @returns The screen.
 */
export function OrganizationsScreen({ scope, q, page, onSearch }: OrganizationsScreenProps) {
  const [text, setText] = useState(q)
  const [creating, setCreating] = useState(false)
  const organizations = useListOrganizations(
    { ...(q ? { q } : {}), page, size: ORGANIZATIONS_PAGE_SIZE },
    { request: useEnvironmentRequest() }
  )

  // The last search this box sent: the address coming back with it is not news, and copying it
  // over the box would drop a key typed while the navigation was under way.
  const sent = useRef(q)
  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q
      setText(q)
    }
  }, [q])

  // What was typed becomes the address's search once the typing pauses. Skipped when it is
  // already the address's (the effect above copies the address into the box, and that must
  // not send anything back).
  useEffect(() => {
    const wanted = text.trim()
    if (wanted === q) {
      return
    }
    const timer = setTimeout(() => {
      sent.current = wanted
      onSearch({ q: wanted, page: 1, replace: true })
    }, ORGANIZATIONS_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, q, onSearch])

  function submit(event: FormEvent) {
    event.preventDefault()
    sent.current = text.trim()
    onSearch({ q: text.trim(), page: 1 })
  }

  return (
    <>
      <PageHeader
        title='Organizations'
        description='The companies, teams and workspaces your users belong to.'
        actions={<ActionButton onClick={() => setCreating(true)}>Create organization</ActionButton>}
      />
      <search>
        <form onSubmit={submit} className='flex flex-wrap items-end gap-2'>
          <div className='flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-sm'>
            <Label htmlFor='organization-search'>Search organizations</Label>
            <Input
              id='organization-search'
              type='search'
              className='bg-field'
              placeholder='Name or slug'
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
      <OrganizationsQueryState query={organizations} label='Loading organizations'>
        {(list) => {
          if (list.data.length === 0 && !q) {
            return (
              <EmptyState title='No organizations yet'>
                Create one here, or let users create their own with “Users may create organizations”
                in{' '}
                <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/organization-settings'>
                  Organization settings
                </EnvironmentLink>
                .
              </EmptyState>
            )
          }
          return (
            <div className='flex flex-col gap-4 rounded-xl border bg-card p-2 sm:p-4'>
              {q ? (
                <p className='px-2 text-sm text-muted-foreground' role='status'>
                  {list.data.length === 0
                    ? 'No organization matches that search.'
                    : `${list.meta.totalCount} ${
                        list.meta.totalCount === 1 ? 'organization matches' : 'organizations match'
                      } that search.`}
                </p>
              ) : null}
              {list.data.length > 0 ? (
                <DataTable
                  caption='Organizations'
                  rows={list.data}
                  rowKey={(organization) => organization.id}
                  columns={[
                    {
                      header: 'Name',
                      cell: (organization) => (
                        <Link
                          to='/w/$workspaceId/p/$projectId/e/$environmentId/organizations/$organizationId'
                          params={{ ...scope, organizationId: organization.id }}
                          className='font-medium text-link underline underline-offset-4'
                        >
                          {printableName(organization.name)}
                        </Link>
                      ),
                    },
                    {
                      header: 'Slug',
                      cell: (organization) => (
                        <code className='text-xs'>{printable(organization.slug)}</code>
                      ),
                    },
                    {
                      header: 'Created by',
                      cell: (organization) =>
                        organization.createdBy === null ? 'An administrator' : 'A user',
                    },
                    {
                      header: 'Created',
                      cell: (organization) => formatDateTime(organization.createdAt),
                    },
                  ]}
                />
              ) : null}
              <div className='px-2'>
                <Pagination
                  label='Organizations'
                  meta={list.meta}
                  onPage={(next) => onSearch({ q, page: next })}
                />
              </div>
            </div>
          )
        }}
      </OrganizationsQueryState>
      <CreateOrganizationDialog open={creating} scope={scope} onClose={() => setCreating(false)} />
    </>
  )
}
