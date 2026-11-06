'use client'

import { formatText, useLocalization, useOrganizationList } from '@tula-tech/react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { FormAlert, Status } from '@/components/tula/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface OrganizationSwitcherProps {
  /**
   * Called after the session's active organization changed: the organization's id, or `null`
   * for the personal account. Refresh whatever your app reads from the session here (your
   * router's `refresh`, a query client's `invalidateQueries`).
   */
  onSwitch?(organizationId: string | null): void
  /**
   * Draws "New organization" under the list. Show it where the environment lets users create
   * organizations (`organizations.allowUserCreated`); the server refuses a creation it does not
   * allow, and the refusal is shown.
   */
  allowCreate?: boolean
  className?: string
}

/** A native select, drawn like the app's input: it is the one control that is right on a phone. */
const SELECT_CLASS =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-3.5 pr-9 text-base shadow-xs transition-[border-color,box-shadow] duration-150 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-busy:cursor-progress aria-busy:opacity-70 motion-reduce:transition-none sm:text-sm'

/**
 * The words of a failed action: the client's own text for a Tula error (the error table of the
 * provider's locale, never the server's sentence), and a fixed line for anything else. A value
 * that is not a Tula error was not written for users.
 */
function failureMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && typeof (caught as { code?: unknown }).code === 'string'
    ? caught.message
    : fallback
}

/**
 * Lists the organizations the signed-in user belongs to and makes one of them the organization
 * the session acts in; "Personal account" clears it. Optionally, a small form creates an
 * organization and switches to it.
 *
 * The list, the switch and the creation are `useOrganizationList()` of `@tula-tech/react`: this
 * file is presentation. Edit the markup and the classes freely. The role and what it allows are
 * `useOrganization()`'s, drawn by the `organization-profile` item.
 */
export function OrganizationSwitcher(props: OrganizationSwitcherProps) {
  const t = useLocalization()
  const list = useOrganizationList()
  const selectId = useId()
  const select = useRef<HTMLSelectElement>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  if (list.error !== null && list.organizations === null) {
    return (
      <div className={cn('grid w-full max-w-sm gap-3', props.className)}>
        <FormAlert message={list.error.message || t.organizations.loadFailed} />
        <Button type='button' variant='outline' onClick={() => void list.reload()}>
          {t.organizations.retry}
        </Button>
      </div>
    )
  }
  if (list.organizations === null) {
    return (
      <p role='status' className='text-sm text-muted-foreground'>
        {t.organizations.loading}
      </p>
    )
  }

  const organizations = list.organizations
  // A stored choice that no longer matches a membership is shown as the personal account: the
  // select must not name an option it does not have.
  const active = organizations.some((entry) => entry.id === list.activeOrganizationId)
    ? list.activeOrganizationId
    : null

  const choose = async (next: string | null) => {
    if (pending) {
      return
    }
    setPending(true)
    setFailure(null)
    setDone(null)
    try {
      await list.setActive(next)
      const name = organizations.find((entry) => entry.id === next)?.name ?? ''
      setDone(
        next === null
          ? t.organizations.switchedToPersonal
          : formatText(t.organizations.switchedTo, { name })
      )
      props.onSwitch?.(next)
    } catch (caught) {
      setFailure(failureMessage(caught, t.organizations.failed))
    } finally {
      setPending(false)
    }
  }

  const create = async (name: string, slug: string): Promise<string | null> => {
    setFailure(null)
    setDone(null)
    let created: Awaited<ReturnType<typeof list.create>>
    try {
      created = await list.create({ name, slug })
    } catch (caught) {
      return failureMessage(caught, t.organizations.failed)
    }
    // The organization exists from here on: a failure to switch must not leave the form open,
    // or a second submit would answer "short name taken" for the user's own organization.
    try {
      await list.setActive(created.id)
      setDone(formatText(t.organizations.created, { name: created.name }))
      props.onSwitch?.(created.id)
    } catch {
      setFailure(formatText(t.organizations.createdNotSwitched, { name: created.name }))
    }
    setCreating(false)
    select.current?.focus()
    return null
  }

  return (
    <div className={cn('grid w-full max-w-sm gap-3', props.className)}>
      <div className='grid gap-2'>
        <Label htmlFor={selectId} className='text-sm font-medium leading-none'>
          {t.organizations.switcherLabel}
        </Label>
        <div className='relative'>
          <select
            ref={select}
            id={selectId}
            value={active ?? ''}
            aria-busy={pending || undefined}
            onChange={(event) => void choose(event.target.value === '' ? null : event.target.value)}
            className={SELECT_CLASS}
          >
            <option value=''>{t.organizations.personalAccount}</option>
            {organizations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <svg
            aria-hidden='true'
            viewBox='0 0 16 16'
            className='pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.5'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='m4 6 4 4 4-4' />
          </svg>
        </div>
      </div>
      {organizations.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{t.organizations.empty}</p>
      ) : null}
      <FormAlert message={failure} />
      <Status message={done} />
      {props.allowCreate ? (
        creating ? (
          <CreateForm onCreate={create} onCancel={() => setCreating(false)} />
        ) : (
          <Button type='button' variant='outline' onClick={() => setCreating(true)}>
            {t.organizations.newOrganization}
          </Button>
        )
      ) : null}
    </div>
  )
}

/** The name and the short name of a new organization, and the buttons that send or drop them. */
function CreateForm(props: {
  onCreate(name: string, slug: string): Promise<string | null>
  onCancel(): void
}) {
  const t = useLocalization()
  const id = useId()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [missing, setMissing] = useState<{ name: boolean; slug: boolean }>({
    name: false,
    slug: false,
  })
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) {
      return
    }
    const next = { name: name.trim() === '', slug: slug.trim() === '' }
    setMissing(next)
    if (next.name || next.slug) {
      // The user lands on the first thing to fix.
      form.current?.querySelector<HTMLElement>(next.name ? '[name=name]' : '[name=slug]')?.focus()
      return
    }
    setPending(true)
    setFailure(null)
    const refused = await props.onCreate(name.trim(), slug.trim())
    setPending(false)
    if (refused !== null) {
      setFailure(refused)
    }
  }

  return (
    <form ref={form} noValidate className='grid gap-4' onSubmit={(event) => void submit(event)}>
      <FormAlert message={failure} />
      <div className='grid gap-2'>
        <Label htmlFor={`${id}-name`} className='text-sm font-medium leading-none'>
          {t.organizations.nameLabel}
        </Label>
        <Input
          id={`${id}-name`}
          name='name'
          autoComplete='organization'
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setMissing((current) => ({ ...current, name: false }))
          }}
          aria-invalid={missing.name || undefined}
          aria-describedby={missing.name ? `${id}-name-error` : undefined}
          className='h-10 rounded-lg px-3.5 text-base sm:text-sm'
        />
        {missing.name ? (
          <p id={`${id}-name-error`} role='alert' className='text-sm text-destructive'>
            {t.common.required}
          </p>
        ) : null}
      </div>
      <div className='grid gap-2'>
        <Label htmlFor={`${id}-slug`} className='text-sm font-medium leading-none'>
          {t.organizations.slugLabel}
        </Label>
        <Input
          id={`${id}-slug`}
          name='slug'
          autoCapitalize='none'
          autoCorrect='off'
          spellCheck={false}
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value)
            setMissing((current) => ({ ...current, slug: false }))
          }}
          aria-invalid={missing.slug || undefined}
          aria-describedby={missing.slug ? `${id}-slug-error ${id}-slug-hint` : `${id}-slug-hint`}
          className='h-10 rounded-lg px-3.5 text-base sm:text-sm'
        />
        <p id={`${id}-slug-hint`} className='text-sm text-muted-foreground'>
          {t.organizations.slugHint}
        </p>
        {missing.slug ? (
          <p id={`${id}-slug-error`} role='alert' className='text-sm text-destructive'>
            {t.common.required}
          </p>
        ) : null}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          type='submit'
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className='aria-disabled:cursor-not-allowed aria-disabled:opacity-70'
        >
          {t.organizations.createSubmit}
        </Button>
        <Button type='button' variant='ghost' onClick={props.onCancel}>
          {t.organizations.cancel}
        </Button>
      </div>
    </form>
  )
}
