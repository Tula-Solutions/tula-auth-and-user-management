import { MAX_WEBHOOK_URL_LENGTH } from '@tula/contract'
import { ACTIVITY_TYPES, type ActivityType } from '@tula/contract/event-types'
import { useId } from 'react'
import { fieldErrorMap, toApiError } from '~/api/errors'
import { TextField } from '~/components/field'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import { type WebhookAction, webhookMessageFor } from './words'

/** What is wrong with an endpoint's form, by field. */
export interface EndpointProblems {
  url?: string
  eventTypes?: string
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
 * The rules are the schema's (`CreateWebhookEndpointRequestSchema`,
 * `UpdateWebhookEndpointRequestSchema`): this only says which field broke one, and how to
 * put it right.
 *
 * @param issues - The parse's issues.
 * @param url - The address as typed, to tell "empty" from "not acceptable".
 * @returns The first problem of each field.
 */
export function endpointProblems(issues: readonly Issue[], url: string): EndpointProblems {
  const problems: EndpointProblems = {}
  for (const issue of issues) {
    if (issue.path[0] === 'url') {
      problems.url ??=
        url === ''
          ? 'Enter the address of your endpoint, starting with https://.'
          : issue.code === 'too_big'
            ? `Use ${MAX_WEBHOOK_URL_LENGTH} characters or fewer.`
            : issue.message
    } else if (issue.path[0] === 'eventTypes') {
      problems.eventTypes ??= 'Choose at least one event type.'
    } else {
      // An issue of the whole body: an update that names no field.
      problems.general ??=
        issue.path.length === 0 ? 'Change the address or the event types first.' : issue.message
    }
  }
  return problems
}

/**
 * Put the server's refusal of an endpoint's form on the field it is about.
 *
 * @param error - What the mutation threw, or nothing.
 * @param action - `create` for a registration (the endpoint limit is said there).
 * @returns The problems; empty when nothing failed.
 */
export function serverProblems(error: unknown, action: WebhookAction = 'other'): EndpointProblems {
  if (!error) {
    return {}
  }
  const fields = fieldErrorMap(error)
  // The outbound guard's refusal names no field, but it is always about the address.
  const url =
    toApiError(error).code === 'webhook.url_not_allowed' ? webhookMessageFor(error) : fields.url
  return url || fields.eventTypes
    ? { url, eventTypes: fields.eventTypes }
    : { general: webhookMessageFor(error, action) }
}

/**
 * The event types chosen, in the contract's order.
 *
 * @param chosen - The chosen types.
 * @returns The same types, ordered as `ACTIVITY_TYPES` lists them.
 */
export function orderedTypes(chosen: ReadonlySet<string>): ActivityType[] {
  return ACTIVITY_TYPES.filter((type) => chosen.has(type))
}

/**
 * The address field of an endpoint's form.
 *
 * @param props - `value`, `onChange` and the field's `error`.
 * @returns The field.
 */
export function AddressField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  return (
    <TextField
      label='Address'
      inputMode='url'
      autoComplete='off'
      autoCapitalize='off'
      spellCheck={false}
      placeholder='https://api.example.com/webhooks/tula'
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      hint='Where events are posted. It must be https, with no user name or password, on a host the server can reach on the public internet.'
    />
  )
}

/**
 * The event types of an endpoint, as a named group of checkboxes: one per type the contract
 * defines, and nothing else can be chosen.
 *
 * @param props - `value`: the chosen types; `onChange`; the group's `error`.
 * @returns The group.
 */
export function EventTypesField({
  value,
  onChange,
  error,
}: {
  value: ReadonlySet<string>
  onChange: (value: Set<string>) => void
  error?: string
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  function toggle(type: string, checked: boolean) {
    const next = new Set(value)
    if (checked) {
      next.add(type)
    } else {
      next.delete(type)
    }
    onChange(next)
  }
  return (
    <fieldset
      aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      aria-invalid={error ? true : undefined}
      className='flex min-w-0 flex-col gap-2'
    >
      <legend className='text-sm font-medium'>Event types</legend>
      <p id={hintId} className='text-xs text-muted-foreground'>
        Only events of the types you choose are sent. There is no “all events”: name the ones your
        backend handles.
      </p>
      <div className='grid max-h-64 gap-x-4 gap-y-2 overflow-y-auto rounded-md border bg-field p-3 sm:grid-cols-2'>
        {ACTIVITY_TYPES.map((type) => (
          <div key={type} className='flex items-center gap-2'>
            <Checkbox
              id={`${id}-${type}`}
              checked={value.has(type)}
              onCheckedChange={(checked) => toggle(type, checked === true)}
            />
            <Label htmlFor={`${id}-${type}`} className='font-mono text-xs font-normal break-all'>
              {type}
            </Label>
          </div>
        ))}
      </div>
      {error ? (
        <p id={errorId} role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}
