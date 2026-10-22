import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  FileText,
  MessageCircle,
  Plug,
  Sparkles,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Crumb, OrderedPage } from '~/lib/anatomy'
import { assistantLinks } from '~/lib/page-actions'
import { issueLink, readableDate, type SourceLink } from '~/lib/page-source'

/** The address of a route under the base. */
function href(base: string, route: string): string {
  return `${base.replace(/\/$/, '')}${route}`
}

/**
 * The page's breadcrumb: the tab, the group, the pages it hangs under, and the page. The last
 * step is the current page and not a link.
 *
 * @param props - The steps and the base path.
 * @returns A navigation landmark, or nothing for a page no tab lists.
 */
export function Breadcrumb({ crumbs, base }: { crumbs: readonly Crumb[]; base: string }) {
  if (crumbs.length === 0) {
    return null
  }
  return (
    <nav className='breadcrumb' aria-label='Breadcrumb'>
      <ol>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <li key={crumb.label}>
              {last ? (
                <span aria-current='page'>{crumb.label}</span>
              ) : crumb.route === undefined ? (
                <span>{crumb.label}</span>
              ) : (
                <a href={href(base, crumb.route)}>{crumb.label}</a>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** One entry of the menu. */
interface MenuEntry {
  id: string
  label: string
  icon: ReactNode
  /** An address the entry opens, or none for one that acts. */
  href?: string
  /** What a reader without a script is sent to instead of an action. */
  fallbackHref?: string
  external?: boolean
}

function EntryBody({ entry }: { entry: MenuEntry }) {
  return (
    <>
      {entry.icon}
      <span className='menu-label'>{entry.label}</span>
      {entry.external === true ? <ArrowUpRight className='menu-out' aria-hidden='true' /> : null}
    </>
  )
}

/**
 * The page's actions: a split button whose main action copies the page's Markdown and whose
 * menu opens the same text in an assistant or sets up the MCP server.
 *
 * Without a script every action is a plain link: the main action and the menu's entries lead to
 * the Markdown twin, the assistants and the MCP page, and the menu is a `details`. With one, the
 * script (`client/page.ts`) copies, announces "Copied", and runs the menu as a menu button
 * (arrow keys, Home, End, Escape). Both are in the markup and CSS shows the one that works
 * (`data-js` on the root, set before the first paint).
 *
 * @param props - The path of the Markdown twin under the base, its absolute address, and the
 *   address of the MCP page.
 * @returns The container for the `page-actions` slot's content.
 */
export function PageActions({
  twinHref,
  twinAddress,
  mcpHref,
}: {
  twinHref: string
  twinAddress: string
  mcpHref: string
}) {
  const links = assistantLinks(twinAddress)
  const entries: MenuEntry[] = [
    {
      id: 'markdown',
      label: 'View as Markdown',
      icon: <FileText aria-hidden='true' />,
      href: twinHref,
      external: true,
    },
    {
      id: 'claude',
      label: 'Open in Claude',
      icon: <Sparkles aria-hidden='true' />,
      href: links.claude,
      external: true,
    },
    {
      id: 'chatgpt',
      label: 'Open in ChatGPT',
      icon: <MessageCircle aria-hidden='true' />,
      href: links.chatgpt,
      external: true,
    },
    {
      id: 'cursor',
      label: 'Open in Cursor',
      icon: <SquareTerminal aria-hidden='true' />,
      href: links.cursor,
      external: true,
    },
    {
      id: 'mcp',
      label: 'Copy MCP setup',
      icon: <Plug aria-hidden='true' />,
      fallbackHref: mcpHref,
    },
  ]
  return (
    <div className='split' data-page-actions data-twin={twinHref}>
      <div className='split-js'>
        <button type='button' className='split-main' data-action='copy'>
          <Copy className='icon-copy' aria-hidden='true' />
          <Check className='icon-done' aria-hidden='true' />
          <span data-label>Copy page</span>
        </button>
        <button
          type='button'
          className='split-more'
          aria-haspopup='menu'
          aria-expanded='false'
          aria-controls='page-menu'
          aria-label='More page actions'
        >
          <ChevronDown aria-hidden='true' />
        </button>
        <div className='menu' id='page-menu' role='menu' aria-label='Page actions' hidden>
          {entries.map((entry) =>
            entry.href === undefined ? (
              <button
                key={entry.id}
                type='button'
                role='menuitem'
                data-action={entry.id}
                tabIndex={-1}
              >
                <EntryBody entry={entry} />
              </button>
            ) : (
              <a
                key={entry.id}
                role='menuitem'
                href={entry.href}
                target='_blank'
                rel='noopener noreferrer'
                tabIndex={-1}
              >
                <EntryBody entry={entry} />
              </a>
            )
          )}
        </div>
        <span className='visually-hidden' role='status' aria-live='polite' data-status />
      </div>
      <div className='split-nojs'>
        <a className='split-main' href={twinHref}>
          <FileText aria-hidden='true' />
          <span>View as Markdown</span>
        </a>
        <details className='menu-nojs'>
          <summary className='split-more' aria-label='More page actions'>
            <ChevronDown aria-hidden='true' />
          </summary>
          <ul className='menu'>
            {entries
              .filter((entry) => entry.id !== 'markdown')
              .map((entry) => (
                <li key={entry.id}>
                  <a
                    href={entry.href ?? entry.fallbackHref}
                    {...(entry.external === true
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : {})}
                  >
                    <EntryBody entry={entry} />
                  </a>
                </li>
              ))}
          </ul>
        </details>
      </div>
    </div>
  )
}

function PagerLink({
  page,
  direction,
  base,
}: {
  page: OrderedPage
  direction: 'previous' | 'next'
  base: string
}) {
  const Arrow = direction === 'previous' ? ArrowLeft : ArrowRight
  return (
    <a
      className='pager-link'
      data-direction={direction}
      href={href(base, page.route)}
      rel={direction === 'previous' ? 'prev' : 'next'}
    >
      <span className='pager-caption'>
        {direction === 'previous' ? <Arrow aria-hidden='true' /> : null}
        {direction === 'previous' ? 'Previous' : 'Next'}
        {direction === 'next' ? <Arrow aria-hidden='true' /> : null}
      </span>
      <span className='pager-title'>{page.label}</span>
      <span className='pager-where'>{page.group}</span>
    </a>
  )
}

/**
 * What closes a page: the feedback row, the source and date, and the previous and next pages.
 *
 * "Was this helpful?" keeps nothing and sends nothing: an answer is a thank-you and a link to
 * open an issue, so there is no request to fail and nothing to disclose. Without a script the
 * row is only the link.
 *
 * @param props - The page's title, route and absolute address; its source link and date; its
 *   neighbours; the base path.
 * @returns A `footer` for the end of the main column.
 */
export function PageFooter({
  title,
  pageAddress,
  source,
  updated,
  previous,
  next,
  base,
}: {
  title: string
  pageAddress: string
  source: SourceLink
  updated: string | undefined
  previous: OrderedPage | undefined
  next: OrderedPage | undefined
  base: string
}) {
  const issue = issueLink(title, pageAddress)
  const date = updated === undefined ? undefined : readableDate(updated)
  return (
    <footer className='page-foot'>
      <div className='feedback' data-feedback>
        <div className='feedback-ask'>
          <p className='feedback-question' id='feedback-question'>
            Was this page helpful?
          </p>
          <div className='feedback-buttons'>
            <button type='button' data-answer='yes' aria-label='Yes, this page was helpful'>
              <ThumbsUp aria-hidden='true' />
              Yes
            </button>
            <button type='button' data-answer='no' aria-label='No, this page was not helpful'>
              <ThumbsDown aria-hidden='true' />
              No
            </button>
          </div>
        </div>
        <p className='feedback-thanks' tabIndex={-1} hidden data-thanks>
          <span data-thanks-text />{' '}
          <a href={issue} target='_blank' rel='noopener noreferrer'>
            Open an issue
          </a>
        </p>
        <p className='feedback-nojs'>
          Something wrong or missing?{' '}
          <a href={issue} target='_blank' rel='noopener noreferrer'>
            Open an issue
          </a>
        </p>
      </div>
      <p className='page-meta'>
        <a href={source.href} target='_blank' rel='noopener noreferrer'>
          {source.label}
          <ArrowUpRight aria-hidden='true' />
        </a>
        {updated !== undefined && date !== undefined ? (
          <span>
            Last updated <time dateTime={updated}>{date}</time>
          </span>
        ) : null}
      </p>
      {previous === undefined && next === undefined ? null : (
        <nav className='pager' aria-label='Previous and next pages'>
          {previous === undefined ? (
            <span />
          ) : (
            <PagerLink page={previous} direction='previous' base={base} />
          )}
          {next === undefined ? <span /> : <PagerLink page={next} direction='next' base={base} />}
        </nav>
      )}
    </footer>
  )
}
