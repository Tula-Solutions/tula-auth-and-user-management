import {
  hasOrganizationAccess,
  type OrganizationCheck,
  readOrganizationClaims,
} from '@tula-tech/contract/custom-claims'
import type { TulaError, UserOrganization } from '@tula-tech/core'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { useOrganizationList } from '../hooks/use-organization'
import { useClientConfig } from '../hooks/use-password-checklist'
import type { FieldResolver } from './form-errors'
import { Button, Card, FormError, useUi } from './ui'

// What the three organization components share (ADR 0065, Orgs 07): which organization a
// component acts on and what the user may do in it, a guard that keeps a result with the session
// it was asked for, and the few controls the sections have in common.

/**
 * The codes that say what the user may do in an organization has changed since the page was
 * drawn: the role was changed, the membership removed. The component reads the organizations
 * again, so that a control the user no longer has goes away.
 */
const ACCESS_CHANGED_CODES: ReadonlySet<string> = new Set([
  'organization.permission_required',
  'organization.not_a_member',
  'auth.forbidden',
])

/**
 * @param error - A failed action's error.
 * @returns Whether it says the user's access to the organization is not what the page assumed.
 */
export function isAccessChanged(error: TulaError | null): boolean {
  return error !== null && ACCESS_CHANGED_CODES.has(error.code)
}

/**
 * What a component can say about the organization it acts on.
 *
 * - `signed-out`: nobody is signed in.
 * - `off`: the environment has organizations switched off, or does not say (an older server).
 * - `none`: no organization is named and none is active.
 * - `loading`, `error`: the user's organizations are being fetched, or could not be.
 * - `not-member`: the user's organizations do not list it (removed, deleted, never joined).
 * - `ready`: the organization and the user's role in it are known.
 */
export type TargetStatus =
  | 'signed-out'
  | 'off'
  | 'none'
  | 'loading'
  | 'error'
  | 'not-member'
  | 'ready'

/** What {@link useTargetOrganization} returns. */
export interface Target {
  status: TargetStatus
  sessionId: string | null
  organizationId: string | null
  organization: UserOrganization | null
  /** The error that left the list unknown, in `error`. */
  error: TulaError | null
  /** Whether the user's role in the organization grants a permission. False until `ready`. */
  has(check: OrganizationCheck): boolean
  /** Fetch the user's organizations again (their role and permissions come with them). */
  reload(): Promise<void>
}

/**
 * The organization a component acts on, with the user's role in it.
 *
 * `organizationId` names one; without it, it is the session's active organization. The role and
 * its permissions come from the user's organization list (which the API builds from the
 * membership as it is now), checked with the same grammar as a token's claims. They decide
 * what is drawn; the server decides what is allowed.
 *
 * @param organizationId - The organization, or `undefined` for the active one.
 * @returns The target.
 */
export function useTargetOrganization(organizationId?: string): Target {
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const config = useClientConfig()
  const list = useOrganizationList()
  const sessionId = state.status === 'signed-in' ? state.sessionId : null
  const targetId = organizationId ?? (state.status === 'signed-in' ? state.organizationId : null)
  const organization =
    targetId === null ? null : (list.organizations?.find((entry) => entry.id === targetId) ?? null)
  // The same grammar and bounds as the claims of a token: a malformed answer is no role.
  const claims = useMemo(
    () =>
      organization
        ? readOrganizationClaims({
            org_id: organization.id,
            org_role: organization.role,
            org_perms: organization.permissions,
          })
        : null,
    [organization]
  )
  const has = useCallback(
    (check: OrganizationCheck) =>
      sessionId !== null &&
      client.state.status === 'signed-in' &&
      client.state.sessionId === sessionId &&
      hasOrganizationAccess(claims, check),
    [client, sessionId, claims]
  )
  let status: TargetStatus
  if (sessionId === null) {
    status = 'signed-out'
  } else if (config?.organizations?.enabled !== true) {
    // Not known yet, or off: either way there is nothing to draw (an older server has none).
    status = 'off'
  } else if (targetId === null) {
    status = 'none'
  } else if (list.organizations === null) {
    status = list.error ? 'error' : 'loading'
  } else if (organization === null) {
    status = 'not-member'
  } else {
    status = 'ready'
  }
  return {
    status,
    sessionId,
    organizationId: targetId,
    organization,
    error: list.error,
    has,
    reload: list.reload,
  }
}

/**
 * A check that the session a call started under is still the one signed in, and that the
 * component is still on the page. Call it before the first `await`; call the function it
 * returns before setting state from the answer (react.md: "A result belongs to the session it
 * was asked for").
 *
 * @returns A function that starts a check.
 */
export function useGuard(): () => () => boolean {
  const { client } = useTulaContext()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(() => {
    const sessionOf = () => (client.state.status === 'signed-in' ? client.state.sessionId : null)
    const started = sessionOf()
    return () => mounted.current && started !== null && sessionOf() === started
  }, [client])
}

/** What {@link useActions} returns. */
export interface Actions {
  /** The name of the action in flight, or `null`. */
  busy: string | null
  /** The name of the action `error` is the failure of, or `null`. */
  failed: string | null
  /** Why the last action failed, or `null`. */
  error: TulaError | null
  /** What the last action said it did, or `null`. */
  message: string | null
  /**
   * Run one action. `work` returns the sentence to say when it worked, or nothing. A result,
   * an error and the end of the busy state are dropped when the session changed meanwhile.
   */
  run(
    name: string,
    work: (current: () => boolean) => Promise<string | null | undefined>
  ): Promise<void>
  setError(error: TulaError | null): void
  setMessage(message: string | null): void
}

/**
 * The state every section of the organization profile keeps for what the user does in it: one
 * action at a time, its error and its confirmation.
 *
 * An error that says the user's access changed (`organization.permission_required`,
 * `organization.not_a_member`, `auth.forbidden`) calls `onAccessChanged`: the component reads
 * the user's organizations again, so a control they no longer have goes away.
 *
 * @param onAccessChanged - What to do for such an error.
 * @returns The state and `run`.
 */
export function useActions(onAccessChanged: () => void): Actions {
  const guard = useGuard()
  const [busy, setBusy] = useState<string | null>(null)
  const [errorState, setErrorState] = useState<{ name: string | null; error: TulaError } | null>(
    null
  )
  const [message, setMessage] = useState<string | null>(null)
  const changed = useRef(onAccessChanged)
  changed.current = onAccessChanged
  const run = useCallback<Actions['run']>(
    async (name, work) => {
      const current = guard()
      setBusy(name)
      setErrorState(null)
      setMessage(null)
      try {
        const said = await work(current)
        if (current() && typeof said === 'string') {
          setMessage(said)
        }
      } catch (caught) {
        if (current()) {
          const failure = toTulaError(caught)
          setErrorState({ name, error: failure })
          if (isAccessChanged(failure)) {
            changed.current()
          }
        }
      } finally {
        if (current()) {
          setBusy(null)
        }
      }
    },
    [guard]
  )
  const setError = useCallback(
    (next: TulaError | null) => setErrorState(next === null ? null : { name: null, error: next }),
    []
  )
  return {
    busy,
    failed: errorState?.name ?? null,
    error: errorState?.error ?? null,
    message,
    run,
    setError,
    setMessage,
  }
}

/**
 * Which field of an organization form an error belongs to: the field the server named, and
 * otherwise by the error's code. Anything else is the form's.
 *
 * @param fields - The form's field names.
 * @returns The resolver for `placeErrors`.
 */
export function organizationFieldResolver(fields: readonly string[]): FieldResolver {
  const byCode: Record<string, string> = {
    'organization.slug_taken': 'slug',
    'organization.member_exists': 'email',
    'organization.invitation_exists': 'email',
    'organization.domain_public': 'domain',
    'organization.domain_taken': 'domain',
    'organization.domain_limit': 'domain',
    'organization.domain_address_mismatch': 'email',
  }
  return (code, field) => {
    if (field !== null && fields.includes(field)) {
      return field
    }
    const target = Object.hasOwn(byCode, code) ? byCode[code] : undefined
    if (target !== undefined && fields.includes(target)) {
      return target
    }
    return code.startsWith('verification.') && fields.includes('code') ? 'code' : null
  }
}

/**
 * A native `<select>` with its label, drawn like the other fields: the one control that is
 * right on a phone and in a screen reader.
 *
 * @param props.label - The field's label.
 * @param props.hideLabel - Keep the label for assistive technology only (a select in a row
 *   whose text already says what it is for).
 * @param props.value - The selected value.
 * @param props.options - The choices, by value and text.
 * @param props.onValue - Called with the chosen value.
 * @param props.busy - A change is being sent: further changes are ignored.
 */
export function SelectField(props: {
  label: string
  hideLabel?: boolean
  value: string
  options: readonly { value: string; label: string }[]
  onValue(value: string): void
  busy?: boolean
  errors?: string[]
}) {
  const { el } = useUi()
  const id = useId()
  const invalid = (props.errors ?? []).length > 0
  return (
    <div {...el('field', invalid && 'tula-is-invalid')}>
      <div className={props.hideLabel ? 'tula-visually-hidden' : 'tula-label-row'}>
        <label {...el('label')} htmlFor={id}>
          {props.label}
        </label>
      </div>
      <select
        {...el('select')}
        id={id}
        value={props.value}
        aria-busy={props.busy || undefined}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          if (!props.busy) {
            props.onValue(event.target.value)
          }
        }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {invalid ? (
        <div {...el('fieldError')} role='alert'>
          {props.errors?.join(' ')}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Shown in place of a component when there is nothing it can act on: a card with a title and
 * one line, and the focus on the title when `focusTitle` is set (it appeared after the page).
 *
 * @param props.title - The card's title.
 * @param props.message - The line.
 * @param props.focusTitle - Move focus to the title.
 * @param props.error - A failure to announce under the line (an alert).
 * @param props.action - A button under the line, if there is a way on.
 */
export function Notice(props: {
  title: string
  message: string
  focusTitle?: boolean
  error?: string | null
  action?: { label: string; onClick(): void }
}) {
  return (
    <Card title={props.title} focusTitle={props.focusTitle}>
      <p className='tula-text'>{props.message}</p>
      <FormError message={props.error ?? null} />
      {props.action ? (
        <Button kind='secondary' onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      ) : null}
    </Card>
  )
}

/**
 * The date of an ISO moment in the provider's locale, without reading the clock.
 *
 * @param iso - The moment (ISO 8601).
 * @param locale - A BCP 47 tag.
 * @returns The text; the raw value when it is not a date or the locale is not supported.
 */
export function formatDate(iso: string, locale: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) {
    return iso
  }
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

/**
 * The short name an organization name suggests: lower-case letters and digits joined by single
 * hyphens. The server decides what a slug may be; this only saves typing.
 *
 * @param name - The organization's name.
 * @returns The suggestion, which may be empty.
 */
export function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/**
 * A question with its two answers, drawn under the control that asked it: "Remove Ada? / Cancel
 * / Yes, remove". The focus goes to the first field or button inside, which is the safe answer
 * (Cancel) unless there is a field to fill first; whoever opened it puts the focus back on its
 * own control when the question is dropped.
 *
 * @param props.question - The question, read with the group.
 * @param props.confirmLabel - The destructive answer.
 * @param props.cancelLabel - The safe answer.
 * @param props.pending - The answer is being sent.
 * @param props.disabled - The destructive answer is not available yet (a field is unfilled).
 * @param props.onConfirm - The destructive answer.
 * @param props.onCancel - The safe answer.
 * @param props.children - Fields to fill before the answer (type the name to confirm).
 */
export function Confirmation(props: {
  question: string
  confirmLabel: string
  cancelLabel: string
  pending: boolean
  disabled?: boolean
  onConfirm(): void
  onCancel(): void
  children?: ReactNode
}) {
  const { el } = useUi()
  const questionId = useId()
  const group = useRef<HTMLDivElement>(null)
  // What had the focus when the question opened is the control that asked it: it gets the focus
  // back when the question is dropped.
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    opener.current = document.activeElement
    group.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [])
  const cancel = () => {
    props.onCancel()
    if (opener.current instanceof HTMLElement && opener.current.isConnected) {
      opener.current.focus()
    }
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled question with its two answers, not a form's fieldset
    <div {...el('confirmation')} ref={group} role='group' aria-labelledby={questionId}>
      <p className='tula-text' id={questionId}>
        {props.question}
      </p>
      {props.children}
      <div className='tula-button-row tula-is-compact'>
        <Button kind='secondary' onClick={cancel}>
          {props.cancelLabel}
        </Button>
        <Button
          kind='danger'
          pending={props.pending}
          disabled={props.disabled}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </div>
  )
}
