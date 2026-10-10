import { SMS_USAGE_DEFAULT_DAYS } from '@tula/contract'
import { useState } from 'react'
import { type SmsPrefixUsage, type SmsUsage, useGetSmsUsage } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { type Column, DataTable } from '~/components/data-table'
import { SelectField } from '~/components/field'
import { Section } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { NativeSelectOption } from '~/components/ui/native-select'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { destination, destinationWords, spanSentence, totalsSentence, USAGE_DAYS } from './model'

function number(value: number): string {
  return value.toLocaleString('en')
}

const COLUMNS: Column<SmsPrefixUsage>[] = [
  {
    header: 'Destination',
    cell: (row) => {
      const { prefix, countries } = destination(row.prefix)
      return (
        <span className='flex flex-col'>
          <bdi dir='ltr'>
            <code className='font-semibold'>{prefix}</code>
          </bdi>
          <span className='text-muted-foreground'>{destinationWords(countries)}</span>
        </span>
      )
    },
  },
  { header: 'Codes sent', cell: (row) => number(row.sent) },
  { header: 'Used', cell: (row) => number(row.used) },
  { header: 'Never used', cell: (row) => number(row.unused) },
]

function Usage({ usage }: { usage: SmsUsage }) {
  return (
    <>
      <p className='text-sm' data-usage='totals'>
        <span className='font-semibold'>{spanSentence(usage)}</span> {totalsSentence(usage)}
      </p>
      {usage.prefixes.length === 0 ? (
        <EmptyState title='No code was texted in these days'>
          Nothing was handed to the SMS sender from this environment in the days shown.
        </EmptyState>
      ) : (
        <DataTable
          caption='Codes texted and never used, by destination prefix, most never used first'
          columns={COLUMNS}
          rows={usage.prefixes}
          rowKey={(row) => row.prefix}
        />
      )}
      {usage.truncated ? (
        <p className='text-sm font-medium' data-usage='truncated'>
          More destinations than the {usage.prefixes.length} listed were texted in these days. The
          totals above count all of them.
        </p>
      ) : null}
    </>
  )
}

/**
 * The codes an environment texted and the ones never used, by destination prefix: the answer
 * of `GET /v1/admin/sms/usage`, as counts.
 *
 * It says what the numbers are and are not, and draws no rate, trend or verdict: the server
 * computes none. The destinations come in the server's order, most never used first.
 *
 * @returns The section.
 */
export function SmsUsageSection() {
  const [days, setDays] = useState(SMS_USAGE_DEFAULT_DAYS)
  const usage = useGetSmsUsage({ days }, { request: useEnvironmentRequest() })
  return (
    <Section
      title='Codes sent and never used'
      description='Where this environment’s texted codes went, by destination prefix, and how many of them were then entered. Saved settings do not change these counts.'
      actions={
        <ActionButton
          variant='outline'
          size='sm'
          pending={usage.isFetching}
          onClick={() => void usage.refetch()}
        >
          Read again
        </ActionButton>
      }
    >
      <SelectField
        label='Days'
        className='sm:max-w-xs'
        value={String(days)}
        onChange={(event) => setDays(Number(event.target.value))}
      >
        {USAGE_DAYS.map((span) => (
          <NativeSelectOption key={span} value={String(span)}>
            {span === 1 ? 'Today' : `The last ${span} days`}
          </NativeSelectOption>
        ))}
      </SelectField>
      <QueryState query={usage} label='Loading the counts'>
        {(data) => <Usage usage={data} />}
      </QueryState>
      <ul className='flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground'>
        <li>
          A code sent is a text message the server handed to the SMS sender and the sender did not
          refuse. It is not a delivery (the server gets no receipt), not a count of segments, and
          not an amount of money.
        </li>
        <li>
          Never used means the code of that message was not entered correctly afterwards. That
          includes a code nobody read, and also one that expired or was replaced by a later code:
          some unused codes are ordinary.
        </li>
        <li>
          Counts by destination only: a prefix is a country calling code and says nothing about
          which number or which user a code went to, or who asked for it.
        </li>
        <li>
          Destinations with the most unused codes come first. Neither the server nor this screen
          works out a rate or a trend, or decides that something is abuse. Many codes to one
          destination that nobody uses is what bought traffic (SMS pumping) looks like; taking that
          country out above stops it.
        </li>
      </ul>
    </Section>
  )
}
