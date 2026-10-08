import {
  HOOK_FAILURE_MODES,
  HOOK_MAX_DEADLINE_MS,
  HOOK_MIN_DEADLINE_MS,
  MAX_WEBHOOK_URL_LENGTH,
} from '@tula/contract'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { fieldErrorMap, toApiError } from '~/api/errors'
import { ActionButton } from '~/components/action-button'
import { SelectField, TextField } from '~/components/field'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Address, shownAddress } from '~/features/webhooks/address'
import { failureModeText, type HookAction, hookMessageFor } from './words'

/** What is wrong with a hook's form, by field. */
export interface HookProblems {
  url?: string
  deadlineMs?: string
  failureMode?: string
  /** A failure that belongs to no field. */
  general?: string
}

/** One issue of a failed parse, as far as this form reads it. */
interface Issue {
  path: PropertyKey[]
  code?: string
  message: string
}

/**
 * Put a failed parse of the contract's request schema into the form's words.
 *
 * The rules are the schema's (`CreateHookRequestSchema`, `UpdateHookRequestSchema`): this
 * only says which field broke one, and how to put it right.
 *
 * @param issues - The parse's issues.
 * @param url - The address as typed, to tell "empty" from "not acceptable".
 * @returns The first problem of each field.
 */
export function hookProblems(issues: readonly Issue[], url: string): HookProblems {
  const problems: HookProblems = {}
  for (const issue of issues) {
    if (issue.path[0] === 'url') {
      problems.url ??=
        url === ''
          ? 'Enter the address of your endpoint, starting with https://.'
          : issue.code === 'too_big'
            ? `Use ${MAX_WEBHOOK_URL_LENGTH} characters or fewer.`
            : issue.message
    } else if (issue.path[0] === 'deadlineMs') {
      problems.deadlineMs ??= `Enter a whole number of milliseconds from ${HOOK_MIN_DEADLINE_MS} to ${HOOK_MAX_DEADLINE_MS}.`
    } else if (issue.path[0] === 'failureMode') {
      problems.failureMode ??= 'Choose what happens when a call fails.'
    } else {
      // An issue of the whole body: an update that names no field.
      problems.general ??=
        issue.path.length === 0
          ? 'Change the address, the deadline or what happens when a call fails first.'
          : issue.message
    }
  }
  return problems
}

/**
 * Put the server's refusal of a hook's form on the field it is about.
 *
 * @param error - What the mutation threw, or nothing.
 * @param action - `create` when a hook was being added.
 * @returns The problems; empty when nothing failed.
 */
export function serverProblems(error: unknown, action: HookAction): HookProblems {
  if (!error) {
    return {}
  }
  const fields = fieldErrorMap(error)
  // The outbound guard's refusal names no field, but it is always about the address.
  const url =
    toApiError(error).code === 'hook.url_not_allowed' ? hookMessageFor(error, action) : fields.url
  return url || fields.deadlineMs || fields.failureMode
    ? { url, deadlineMs: fields.deadlineMs, failureMode: fields.failureMode }
    : { general: hookMessageFor(error, action) }
}

/**
 * What a deadline field holds, as the number the request carries.
 *
 * @param typed - The field's text.
 * @returns The number; `NaN` for anything that is not digits only, which the contract's
 *   schema then refuses.
 */
export function deadlineOf(typed: string): number {
  const text = typed.trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

/** The values of a hook's form. */
export interface HookFormValues {
  url: string
  deadline: string
  failureMode: string
}

/**
 * The fields of a hook's form: its address, its deadline and what happens when a call fails.
 *
 * @param props - `values` and `onChange`; `problems`: each field's error.
 * @returns The three fields.
 */
export function HookFields({
  values,
  onChange,
  problems,
}: {
  values: HookFormValues
  onChange: (values: HookFormValues) => void
  problems: HookProblems
}) {
  // A text field draws its value raw: a character nobody can see stays unseen in it. What is
  // sent is the value without the white space around it, so that is what is written out.
  const sent = values.url.trim()
  const written = shownAddress(sent)
  // A mode a later server knows stays selectable as what it is, so that saving another field
  // does not have to change it.
  const modes = HOOK_FAILURE_MODES.includes(values.failureMode as never)
    ? HOOK_FAILURE_MODES
    : [...HOOK_FAILURE_MODES, values.failureMode]
  return (
    <>
      <TextField
        label='Address'
        inputMode='url'
        autoComplete='off'
        autoCapitalize='off'
        spellCheck={false}
        placeholder='https://api.example.com/hooks/tula'
        value={values.url}
        onChange={(event) => onChange({ ...values, url: event.target.value })}
        error={problems.url}
        hint={
          <>
            Where the question is posted. It must be https, with no user name or password, on a host
            the server can reach on the public internet.
            {written === sent ? null : (
              <span data-testid='address-written-out' className='mt-1 block text-foreground'>
                This address holds characters that cannot be seen, or that change how it reads.
                Written out, it is <Address url={sent} />
              </span>
            )}
          </>
        }
      />
      <TextField
        label='Deadline (milliseconds)'
        inputMode='numeric'
        autoComplete='off'
        value={values.deadline}
        onChange={(event) => onChange({ ...values, deadline: event.target.value })}
        error={problems.deadlineMs}
        hint={`How long the server waits for the answer, from ${HOOK_MIN_DEADLINE_MS} to ${HOOK_MAX_DEADLINE_MS}. The person signing in waits that long too.`}
      />
      <SelectField
        label='When a call fails'
        value={values.failureMode}
        onChange={(event) => onChange({ ...values, failureMode: event.target.value })}
        error={problems.failureMode}
        hint='A call fails when the endpoint cannot be reached, does not answer in time, or answers with anything but the answer this point takes.'
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {failureModeText(mode)}
          </option>
        ))}
      </SelectField>
    </>
  )
}

/** Props of {@link WeakeningQuestion}. */
export interface WeakeningQuestionProps {
  /** What the change lets through, one sentence each. */
  sentences: readonly string[]
  /** Text the operator must type first (the point's name, in a production environment). */
  requireText?: string
  /** True from the click until the dialog has moved on. */
  pending: boolean
  /** The confirming button's label. */
  confirmLabel: string
  /** What it says while a request that carries a secret is in flight. */
  pendingLabel?: string
  /** The answer carries a secret shown once: the dialog cannot be left while pending. */
  carriesSecret?: boolean
  /** Shown above the buttons. */
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The question asked before a change that lets through what a hook would stop: what is lost,
 * in sentences, and in a production environment the point's name to type.
 *
 * It is the body of the dialog that holds the form, not a dialog of its own: the form's
 * values stay where they are while the question is open.
 *
 * @param props - See {@link WeakeningQuestionProps}.
 * @returns The question as a form.
 */
export function WeakeningQuestion({
  sentences,
  requireText,
  pending,
  confirmLabel,
  pendingLabel,
  carriesSecret = false,
  children,
  onConfirm,
  onCancel,
}: WeakeningQuestionProps) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const allowed = requireText === undefined || typed === requireText

  function submit(event: FormEvent) {
    event.preventDefault()
    if (allowed && !pending) {
      onConfirm()
    }
  }

  return (
    <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
      <div data-testid='weakening' className='flex flex-col gap-2 text-sm'>
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
        <p className='text-muted-foreground'>This is recorded in the audit log as a weakening.</p>
      </div>
      {requireText !== undefined ? (
        <div className='flex flex-col gap-2'>
          <Label htmlFor={inputId}>
            Type <bdi className='font-mono font-semibold break-all'>{requireText}</bdi> to confirm
          </Label>
          <Input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete='off'
            spellCheck={false}
          />
        </div>
      ) : null}
      {children}
      {carriesSecret ? (
        <SecretRequestActions
          pending={pending}
          unavailable={!allowed}
          onCancel={onCancel}
          submitLabel={confirmLabel}
          pendingLabel={pendingLabel ?? confirmLabel}
        />
      ) : (
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton
            type='submit'
            pending={pending}
            aria-disabled={!allowed || pending || undefined}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      )}
    </form>
  )
}
