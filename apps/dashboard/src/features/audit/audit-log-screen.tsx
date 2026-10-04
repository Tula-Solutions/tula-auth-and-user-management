import { type FormEvent, useEffect, useState } from 'react'
import {
  ActivityType,
  type AuditLog,
  InstanceActivityType,
  ListAuditLogsActorType,
  useListAuditLogs,
  useListInstanceAuditLogs,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { DataTable, Pagination } from '~/components/data-table'
import { SelectField, TextField } from '~/components/field'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { NativeSelectOption } from '~/components/ui/native-select'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { pageSearch } from '~/lib/search'

/** How many entries one page of the log holds. */
export const AUDIT_PAGE_SIZE = 25

/** The audit log's filters, as the address holds them. */
export interface AuditFilters {
  action?: string
  actorType?: string
  actorId?: string
  targetId?: string
  /** A day, `YYYY-MM-DD`: entries from its start (UTC). */
  from?: string
  /** A day, `YYYY-MM-DD`: entries to its end (UTC). */
  to?: string
  page?: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TEXT_FILTERS = ['action', 'actorType', 'actorId', 'targetId'] as const

/**
 * Read the audit filters from a route's search parameters. Anything that is not a filter of
 * the expected shape is left out, so a hand-edited address cannot produce a refused request.
 *
 * @param search - The raw search parameters.
 * @returns The filters.
 */
export function auditSearch(search: Record<string, unknown>): AuditFilters {
  const filters: AuditFilters = { ...pageSearch(search) }
  for (const key of TEXT_FILTERS) {
    const value = search[key]
    if (typeof value === 'string' && value !== '' && value.length <= 200) {
      filters[key] = value
    }
  }
  for (const key of ['from', 'to'] as const) {
    const value = search[key]
    if (typeof value === 'string' && DAY.test(value)) {
      filters[key] = value
    }
  }
  return filters
}

function isOneOf<T extends string>(
  values: Record<string, T>,
  value: string | undefined
): value is T {
  return value !== undefined && Object.values(values).includes(value as T)
}

/**
 * Turn the filters into the API's query: days become instants (UTC), and a value the API
 * does not know for an enumerated filter is left out.
 *
 * @param filters - The filters from the address.
 * @returns The common query parameters.
 */
export function auditQuery(filters: AuditFilters) {
  return {
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.targetId ? { targetId: filters.targetId } : {}),
    ...(filters.from ? { from: `${filters.from}T00:00:00.000Z` } : {}),
    ...(filters.to ? { to: `${filters.to}T23:59:59.999Z` } : {}),
    page: filters.page ?? 1,
    size: AUDIT_PAGE_SIZE,
  }
}

function Details({ entry }: { entry: AuditLog }) {
  const metadata = Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata) : ''
  return (
    <span className='flex flex-col gap-0.5 text-xs'>
      {entry.ipAddress ? <span>IP {entry.ipAddress}</span> : null}
      {/* Server text, rendered as text: React escapes it, and nothing here is ever HTML. */}
      {metadata ? <code className='break-all'>{metadata}</code> : null}
      {!entry.ipAddress && !metadata ? '—' : null}
    </span>
  )
}

const COLUMNS = [
  { header: 'When', cell: (entry: AuditLog) => formatDateTime(entry.occurredAt) },
  { header: 'Action', cell: (entry: AuditLog) => <code className='text-xs'>{entry.action}</code> },
  {
    header: 'Actor',
    cell: (entry: AuditLog) => (
      <span className='flex flex-col'>
        <span className='font-medium' data-actor-type={entry.actor.type}>
          {entry.actor.type}
        </span>
        {entry.actor.id ? <code className='text-xs break-all'>{entry.actor.id}</code> : null}
      </span>
    ),
  },
  {
    header: 'Target',
    cell: (entry: AuditLog) =>
      entry.target ? (
        <span className='flex flex-col'>
          <span>{entry.target.type}</span>
          <code className='text-xs break-all'>{entry.target.id}</code>
        </span>
      ) : (
        '—'
      ),
  },
  { header: 'Details', cell: (entry: AuditLog) => <Details entry={entry} /> },
]

function useEntries(scope: 'environment' | 'instance', filters: AuditFilters) {
  const common = auditQuery(filters)
  const request = useEnvironmentRequest()
  const environment = useListAuditLogs(
    {
      ...common,
      ...(isOneOf(ActivityType, filters.action) ? { action: filters.action } : {}),
      ...(isOneOf(ListAuditLogsActorType, filters.actorType)
        ? { actorType: filters.actorType }
        : {}),
    },
    { query: { enabled: scope === 'environment' }, request }
  )
  const instance = useListInstanceAuditLogs(
    {
      ...common,
      ...(isOneOf(InstanceActivityType, filters.action) ? { action: filters.action } : {}),
    },
    { query: { enabled: scope === 'instance' } }
  )
  return scope === 'environment' ? environment : instance
}

/** Props of {@link AuditLogScreen}. */
export interface AuditLogScreenProps {
  /** Which log: one environment's, or the instance's own. */
  scope: 'environment' | 'instance'
  /** The filters from the address. */
  filters: AuditFilters
  /** Put new filters in the address. */
  onFilters: (filters: AuditFilters) => void
}

/**
 * An audit log with its filters and pages: an environment's (users, sessions, keys,
 * settings) or the instance's (dashboard sign-ins, workspaces, projects, environments).
 *
 * @param props - See {@link AuditLogScreenProps}.
 * @returns The screen.
 */
export function AuditLogScreen({ scope, filters, onFilters }: AuditLogScreenProps) {
  const [form, setForm] = useState<AuditFilters>(filters)
  const entries = useEntries(scope, filters)
  const actions = Object.values(scope === 'environment' ? ActivityType : InstanceActivityType)
  const filtered = Object.keys(filters).some((key) => key !== 'page')

  useEffect(() => {
    setForm(filters)
  }, [filters])

  function submit(event: FormEvent) {
    event.preventDefault()
    const { page: _page, ...rest } = form
    onFilters(auditSearch(rest as Record<string, unknown>))
  }

  function field(key: keyof Omit<AuditFilters, 'page'>) {
    return {
      value: form[key] ?? '',
      onChange: (event: { target: { value: string } }) =>
        setForm({ ...form, [key]: event.target.value }),
    }
  }

  return (
    <>
      <PageHeader
        title={scope === 'environment' ? 'Audit log' : 'Instance audit log'}
        description={
          scope === 'environment'
            ? 'Every change to who can do what in this environment, newest first. Changes made here show the actor “instance_admin”.'
            : 'What has no environment: dashboard sign-ins, and workspaces, projects and environments being created.'
        }
      />
      <form
        onSubmit={submit}
        aria-label='Filter the audit log'
        className='grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3'
      >
        <SelectField label='Action' {...field('action')}>
          <NativeSelectOption value=''>Any action</NativeSelectOption>
          {actions.map((action) => (
            <NativeSelectOption key={action} value={action}>
              {action}
            </NativeSelectOption>
          ))}
        </SelectField>
        {scope === 'environment' ? (
          <SelectField label='Actor type' {...field('actorType')}>
            <NativeSelectOption value=''>Any actor</NativeSelectOption>
            {Object.values(ListAuditLogsActorType).map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type}
              </NativeSelectOption>
            ))}
          </SelectField>
        ) : null}
        <TextField label='Actor id' autoComplete='off' spellCheck={false} {...field('actorId')} />
        <TextField label='Target id' autoComplete='off' spellCheck={false} {...field('targetId')} />
        <TextField label='From (day, UTC)' type='date' {...field('from')} />
        <TextField label='To (day, UTC)' type='date' {...field('to')} />
        <div className='flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3'>
          <ActionButton type='submit'>Apply filters</ActionButton>
          {filtered ? (
            <ActionButton variant='outline' onClick={() => onFilters({})}>
              Clear filters
            </ActionButton>
          ) : null}
        </div>
      </form>
      <QueryState query={entries} label='Loading the audit log'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState
              title={filtered ? 'No entry matches these filters' : 'Nothing recorded yet'}
            />
          ) : (
            <div className='flex flex-col gap-4 rounded-xl border bg-card p-2 sm:p-4'>
              <DataTable
                caption='Audit entries'
                rows={list.data}
                rowKey={(entry) => entry.id}
                columns={COLUMNS}
              />
              <div className='px-2'>
                <Pagination
                  label='Audit log'
                  meta={list.meta}
                  onPage={(page) => onFilters({ ...filters, page })}
                />
              </div>
            </div>
          )
        }
      </QueryState>
    </>
  )
}
