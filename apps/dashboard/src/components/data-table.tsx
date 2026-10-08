import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { ActionButton } from './action-button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'

/** One column of a {@link DataTable}. */
export interface Column<Row> {
  /** The column's heading; also the label of its cell when rows are stacked on a phone. */
  header: string
  /** What the cell shows for a row. */
  cell: (row: Row) => ReactNode
  /** Extra classes for the cell. */
  className?: string
}

/** Props of {@link DataTable}. */
export interface DataTableProps<Row> {
  /** What the table lists, for assistive technology (visually hidden). */
  caption: string
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
}

/**
 * A table that stays readable at 375px.
 *
 * From the `sm` breakpoint up it is an ordinary table. Below it each row becomes a block and
 * each cell a "label: value" line (the label comes from the column's heading), so nothing
 * scrolls sideways. The ARIA roles are written out because changing a table's `display`
 * makes browsers drop its semantics.
 *
 * @param props - See {@link DataTableProps}.
 * @returns The table.
 */
export function DataTable<Row>({ caption, columns, rows, rowKey }: DataTableProps<Row>) {
  return (
    <Table role='table' className='max-sm:block'>
      <TableCaption className='sr-only'>{caption}</TableCaption>
      <TableHeader role='rowgroup' className='max-sm:sr-only'>
        <TableRow role='row'>
          {columns.map((column) => (
            <TableHead
              key={column.header}
              role='columnheader'
              scope='col'
              className='text-muted-foreground'
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody role='rowgroup' className='max-sm:flex max-sm:flex-col max-sm:gap-3'>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            role='row'
            className='max-sm:flex max-sm:flex-col max-sm:rounded-lg max-sm:border max-sm:p-3'
          >
            {columns.map((column) => (
              <TableCell
                key={column.header}
                role='cell'
                data-label={column.header}
                className={cn(
                  'whitespace-normal max-sm:flex max-sm:items-start max-sm:justify-between max-sm:gap-4 max-sm:px-0 max-sm:py-1',
                  'max-sm:before:shrink-0 max-sm:before:text-xs max-sm:before:font-medium max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]',
                  column.className
                )}
              >
                <span className='min-w-0 break-words max-sm:text-right'>{column.cell(row)}</span>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The page counters every list of the API answers with. */
export interface PageMeta {
  totalCount: number
  totalPages: number
  page: number
  perPage: number
}

/**
 * Previous / next for a paged list, with where the reader is.
 *
 * @param props - `meta`: the list's page counters; `onPage`: go to a page; `label`: what is
 *   paged ("Users").
 * @returns The navigation, or nothing for a list of one page.
 */
export function Pagination({
  meta,
  onPage,
  label,
}: {
  meta: PageMeta
  onPage: (page: number) => void
  label: string
}) {
  if (meta.totalPages <= 1) {
    return (
      <p className='text-sm text-muted-foreground'>
        {meta.totalCount} {meta.totalCount === 1 ? 'entry' : 'entries'}
      </p>
    )
  }
  return (
    <nav
      aria-label={`${label} pages`}
      className='flex flex-wrap items-center justify-between gap-3'
    >
      <p className='text-sm text-muted-foreground' aria-live='polite'>
        Page {meta.page} of {meta.totalPages} · {meta.totalCount} entries
      </p>
      <div className='flex gap-2'>
        <ActionButton
          variant='outline'
          size='sm'
          disabled={meta.page <= 1}
          onClick={() => onPage(meta.page - 1)}
        >
          Previous
        </ActionButton>
        <ActionButton
          variant='outline'
          size='sm'
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
        >
          Next
        </ActionButton>
      </div>
    </nav>
  )
}
