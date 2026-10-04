import { CircleAlert, CircleCheck, CircleMinus, TriangleAlert } from 'lucide-react'
import {
  type DiagnosticCheck,
  type DiagnosticStatus,
  useGetInstanceDiagnostics,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { PageHeader, Section } from '~/components/page'
import { QueryState } from '~/components/states'
import { formatDateTime } from '~/lib/format'
import { cn } from '~/lib/utils'

const STATUS: Record<
  DiagnosticStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  ok: { label: 'OK', icon: CircleCheck, className: 'text-success' },
  warn: { label: 'Warning', icon: TriangleAlert, className: 'text-foreground' },
  fail: { label: 'Failing', icon: CircleAlert, className: 'text-destructive' },
  skipped: { label: 'Skipped', icon: CircleMinus, className: 'text-muted-foreground' },
}

/** Failing checks first, then warnings: what needs attention is at the top. */
const ORDER: Record<DiagnosticStatus, number> = { fail: 0, warn: 1, ok: 2, skipped: 3 }

function Check({ check }: { check: DiagnosticCheck }) {
  const status = STATUS[check.status]
  return (
    <li className='flex flex-col gap-1.5 border-b py-3 last:border-b-0' data-status={check.status}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <code className='text-sm font-semibold'>{check.id}</code>
        <span
          className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', status.className)}
        >
          <status.icon aria-hidden='true' className='size-4' />
          {status.label}
        </span>
      </div>
      <p className='text-sm'>{check.summary}</p>
      {check.values && check.values.length > 0 ? (
        <ul className='flex flex-wrap gap-1.5'>
          {check.values.map((value) => (
            <li key={value}>
              <code className='rounded border px-1.5 py-0.5 text-xs break-all'>{value}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {check.fix ? (
        <p className='text-sm'>
          <span className='font-semibold'>Fix: </span>
          {check.fix}
        </p>
      ) : null}
    </li>
  )
}

/**
 * The deployment's diagnostics: the same checks `tula doctor` prints, each with its fix.
 *
 * Everything shown is fixed text the server chose (never a connection string or a key), and
 * it is rendered as text.
 *
 * @returns The screen.
 */
export function DiagnosticsScreen() {
  const diagnostics = useGetInstanceDiagnostics({ query: { staleTime: 0 } })
  return (
    <>
      <PageHeader
        title='Diagnostics'
        description='Checks of this deployment’s configuration and dependencies: what `tula doctor` reports.'
        actions={
          <ActionButton
            variant='outline'
            pending={diagnostics.isFetching}
            onClick={() => void diagnostics.refetch()}
          >
            Run again
          </ActionButton>
        }
      />
      <QueryState query={diagnostics} label='Running the checks'>
        {(report) => {
          const checks = [...report.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status])
          const failing = checks.filter((check) => check.status === 'fail').length
          const warnings = checks.filter((check) => check.status === 'warn').length
          return (
            <>
              <Section title='Deployment'>
                <dl className='grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4'>
                  <div>
                    <dt className='text-xs font-medium text-muted-foreground'>Version</dt>
                    <dd>{report.version}</dd>
                  </div>
                  <div>
                    <dt className='text-xs font-medium text-muted-foreground'>Tier</dt>
                    <dd>{report.environment}</dd>
                  </div>
                  <div>
                    <dt className='text-xs font-medium text-muted-foreground'>Public URL</dt>
                    <dd className='break-all'>{report.publicUrl}</dd>
                  </div>
                  <div>
                    <dt className='text-xs font-medium text-muted-foreground'>Checked</dt>
                    <dd>{formatDateTime(report.time)}</dd>
                  </div>
                </dl>
              </Section>
              <Section
                title='Checks'
                description={
                  failing + warnings === 0
                    ? 'Everything passed.'
                    : `${failing} failing, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`
                }
              >
                <ul>
                  {checks.map((check) => (
                    <Check key={check.id} check={check} />
                  ))}
                </ul>
              </Section>
            </>
          )
        }}
      </QueryState>
    </>
  )
}
