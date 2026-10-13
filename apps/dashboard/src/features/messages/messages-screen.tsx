import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { messageFor, toApiError } from '~/api/errors'
import {
  type MessagePreview,
  type MessagePreviewRequest,
  usePreviewMessage,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Field } from '~/components/field'
import { Section } from '~/components/page'
import { LoadingState } from '~/components/states'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { type SettingsEditor, SettingsFrame } from '~/features/settings/settings-editor'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { unseenCodePoints } from '~/lib/printable'
import { cn } from '~/lib/utils'
import {
  fieldsOf,
  hasOwnWording,
  MESSAGE_GROUPS,
  type MessageField,
  type MessageRef,
  maxLengthOf,
  messageId,
  placeholdersOf,
  previewRequest,
  problemsOf,
  segmentsSentence,
  settingsPath,
  templateOf,
  unusedSentence,
  withField,
  withoutWording,
  wordsOf,
} from './model'

/** How long the draft has to rest before its preview is asked for, in milliseconds. */
export const PREVIEW_DELAY_MS = 300

const FIELD_WORDS: Record<MessageField, { label: string; builtIn: string }> = {
  subject: { label: 'Subject', builtIn: 'Leave empty to send the built-in subject.' },
  body: {
    label: 'Body',
    builtIn:
      'Leave empty to send the built-in body. Text only: a blank line starts a new paragraph, and the layout, the footer and (for a notice) the closing lines are the server’s.',
  },
  text: {
    label: 'Text',
    builtIn:
      'Leave empty to send the built-in text. One line; the server adds its own last line with the code under it.',
  },
}

/**
 * Says which characters of a text cannot be seen, so that what is on the screen can be told
 * from what is stored. Nothing is drawn for a text with none.
 *
 * @param props - `text`: the text as it is.
 * @returns The note, or nothing.
 */
function UnseenNote({ text }: { text: string }) {
  const points = unseenCodePoints(text)
  if (points.length === 0) {
    return null
  }
  return (
    <p className='text-xs text-muted-foreground'>
      Holds characters that cannot be seen ({points.join(', ')}). They are sent as they are.
    </p>
  )
}

/** One part of a message's wording: its control, its placeholders and what is wrong with it. */
function TemplateField({
  message,
  field,
  value,
  problems,
  serverError,
  onChange,
}: {
  message: MessageRef
  field: MessageField
  value: string
  problems: readonly string[]
  serverError: string | undefined
  onChange: (value: string) => void
}) {
  const control = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  // Where the caret goes once the text with a placeholder in it has been drawn.
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caret.current !== null) {
      control.current?.focus()
      control.current?.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })

  function insert(name: string) {
    const token = `{{${name}}}`
    const start = control.current?.selectionStart ?? value.length
    const end = control.current?.selectionEnd ?? start
    caret.current = start + token.length
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`)
  }

  const words = FIELD_WORDS[field]
  // What the contract's validator says now comes first; the server's answer to the last
  // save is about the text as it was sent.
  const error =
    problems.length > 0
      ? problems.map((reason) => `Would be refused: ${reason}.`).join(' ')
      : serverError
  const max = maxLengthOf(field)
  const choices = placeholdersOf(message, field)
  return (
    <div className='flex flex-col gap-2'>
      <Field
        label={words.label}
        hint={`${words.builtIn} ${value.length} of ${max} characters.`}
        error={error}
      >
        {(props) =>
          field === 'subject' ? (
            <Input
              ref={control}
              className='bg-field'
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoComplete='off'
              {...props}
            />
          ) : (
            <Textarea
              ref={control}
              className='bg-field'
              rows={field === 'body' ? 8 : 3}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoComplete='off'
              {...props}
            />
          )
        }
      </Field>
      <UnseenNote text={value} />
      {choices.length > 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would nest a second legend inside the field; the group names the buttons.
        <div
          role='group'
          aria-label={`Placeholders for the ${words.label.toLowerCase()}`}
          className='flex flex-wrap items-center gap-2'
        >
          <span className='text-xs text-muted-foreground'>Insert:</span>
          {choices.map((choice) => (
            <ActionButton
              key={choice.name}
              variant='outline'
              size='sm'
              onClick={() => insert(choice.name)}
              aria-label={`Insert {{${choice.name}}} into the ${words.label.toLowerCase()}${choice.required ? ' (required)' : ''}`}
            >
              <code>{`{{${choice.name}}}`}</code>
              {choice.required ? <span className='text-xs'>required</span> : null}
            </ActionButton>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A preview answer, and the request it answers. */
interface Answered {
  key: string
  preview: MessagePreview
}

/** A preview that failed, and the request that did. */
interface Failed {
  key: string
  error: unknown
}

/**
 * The message as it would be sent with the draft's wording, asked of the server once the
 * draft has rested: only the server has the layout's text, the built-in copy and the
 * environment's own values (ADR 0042).
 *
 * Everything the answer holds is drawn as text. An answer to an earlier draft is never
 * shown as the current one: the status line says when the preview is behind.
 *
 * @param props - `message`; `request`: what to ask, or `null` while the draft would be
 *   refused (nothing is asked then).
 * @returns The preview panel.
 */
function Preview({
  message,
  request,
}: {
  message: MessageRef
  request: MessagePreviewRequest | null
}) {
  const preview = usePreviewMessage({ request: useEnvironmentRequest() })
  const [answered, setAnswered] = useState<Answered | null>(null)
  const [failed, setFailed] = useState<Failed | null>(null)
  const key = request === null ? null : JSON.stringify(request)
  const { mutate } = preview

  useEffect(() => {
    if (key === null) {
      return
    }
    const timer = setTimeout(() => {
      // Only the newest call's callbacks run, and none after the screen is gone: an answer
      // to an earlier draft, or one that arrives after a switch, is dropped.
      mutate(
        { data: JSON.parse(key) as MessagePreviewRequest },
        {
          onSuccess: (data) => {
            setAnswered({ key, preview: data })
            setFailed(null)
          },
          onError: (error) => setFailed({ key, error }),
        }
      )
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key, mutate])

  if (key === null) {
    return (
      <p role='status' className='text-sm text-muted-foreground'>
        No preview: this wording would be refused when saved. Change what is marked above.
      </p>
    )
  }
  const failure = failed?.key === key ? toApiError(failed.error) : null
  if (failure) {
    return (
      <div role='alert' className='flex flex-col gap-1 text-sm'>
        <p className='font-semibold'>The preview could not be made.</p>
        {failure.fieldErrors.length > 0 ? (
          <ul className='list-disc pl-5'>
            {failure.fieldErrors.map((entry) => (
              <li key={`${entry.field}:${entry.message}`}>
                <code className='text-xs'>{entry.field}</code>: {entry.message}
              </li>
            ))}
          </ul>
        ) : (
          <p>{messageFor(failure)}</p>
        )}
      </div>
    )
  }
  // An answer for another message is not this one's, however recent.
  const shown =
    answered !== null &&
    answered.preview.channel === message.channel &&
    answered.preview.kind === message.kind
      ? answered
      : null
  if (shown === null) {
    return <LoadingState label='Loading the preview' />
  }
  const current = shown.key === key
  const { subject, text, unused, segments } = shown.preview
  const size = segmentsSentence(segments)
  return (
    <div className='flex flex-col gap-3' aria-busy={!current || undefined}>
      <p role='status' className='text-xs text-muted-foreground'>
        {current ? 'The preview shows the wording above.' : 'Updating the preview…'}
      </p>
      {unused.map((entry) => (
        <p
          key={`${entry.part}:${entry.reason}`}
          role='alert'
          className='rounded-lg border border-destructive bg-destructive-surface p-3 text-sm'
        >
          {unusedSentence(entry)}
        </p>
      ))}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-lg border bg-background p-4',
          !current && 'opacity-70'
        )}
      >
        {subject !== null ? (
          <div className='flex flex-col gap-1 border-b pb-3'>
            <span className='text-xs font-medium text-muted-foreground'>Subject</span>
            <p className='text-sm font-semibold break-words' dir='auto' data-preview='subject'>
              {subject}
            </p>
          </div>
        ) : null}
        {/* Text, and only text: whatever the wording holds is drawn as characters. */}
        <pre
          className='font-sans text-sm break-words whitespace-pre-wrap'
          dir='auto'
          data-preview='text'
        >
          {text}
        </pre>
      </div>
      <UnseenNote text={`${subject ?? ''}${text}`} />
      {size ? <p className='text-sm'>{size}</p> : null}
      <p className='text-xs text-muted-foreground'>
        With sample values: the code 123456, a sample time, device and provider, and this
        environment’s saved app name and first allowed origin. An email is shown as its text part;
        the HTML part says the same in the server’s layout.
      </p>
    </div>
  )
}

/** The list of kinds, the editor of the chosen one and its preview. */
function MessageEditor({ draft, update, errors }: SettingsEditor) {
  const first = MESSAGE_GROUPS[0]?.messages[0] as MessageRef
  const [message, setMessage] = useState<MessageRef>(first)
  const template = templateOf(draft, message)
  const problems = problemsOf(message, template)
  const refused = Object.keys(problems).length > 0
  const own = hasOwnWording(draft, message)
  const words = wordsOf(message)
  const path = settingsPath(message)

  return (
    <div className='grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]'>
      {/* The list keeps to the part of the window above the save bar and scrolls by itself:
          beside a long editor it stays in view, and none of its rows ends up half under the
          bar's buttons, where it would be too small a target. */}
      <nav
        aria-label='Messages'
        className='flex flex-col gap-4 rounded-xl border bg-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-24rem)] lg:min-h-48 lg:self-start lg:overflow-y-auto'
      >
        {MESSAGE_GROUPS.map((group) => (
          <div key={group.title} className='flex flex-col gap-1'>
            <h2 className='text-xs font-semibold text-muted-foreground'>{group.title}</h2>
            <ul className='flex flex-col'>
              {group.messages.map((entry) => {
                const chosen = messageId(entry) === messageId(message)
                const prefix = `${settingsPath(entry)}.`
                const state = Object.keys(errors).some((field) => field.startsWith(prefix))
                  ? 'Refused'
                  : hasOwnWording(draft, entry)
                    ? 'Own wording'
                    : 'Built-in'
                return (
                  <li key={messageId(entry)}>
                    <button
                      type='button'
                      aria-current={chosen ? 'true' : undefined}
                      onClick={() => setMessage(entry)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        chosen && 'bg-accent font-medium'
                      )}
                    >
                      <span className='min-w-0'>{wordsOf(entry).label}</span>
                      <span className='shrink-0 text-xs text-muted-foreground'>{state}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className='flex min-w-0 flex-col gap-6'>
        <Section
          title={words.label}
          description={words.when}
          actions={
            <ActionButton
              variant='outline'
              size='sm'
              aria-disabled={!own || undefined}
              onClick={() => {
                if (own) {
                  update((current) => withoutWording(current, message))
                }
              }}
            >
              Reset to built-in
            </ActionButton>
          }
        >
          <p role='status' className='text-sm text-muted-foreground'>
            {own
              ? 'This environment has its own wording for this message.'
              : 'This message is sent in the built-in wording.'}
          </p>
          {fieldsOf(message).map((field) => (
            <TemplateField
              // A field keeps its caret and its element: one per message and part.
              key={`${messageId(message)}:${field}`}
              message={message}
              field={field}
              value={template[field] ?? ''}
              problems={problems[field] ?? []}
              serverError={errors[`${path}.${field}`]}
              onChange={(value) => update((current) => withField(current, message, field, value))}
            />
          ))}
        </Section>
        <Section
          title='Preview'
          description='The message as it would be sent with the wording above, saved or not.'
        >
          <Preview message={message} request={refused ? null : previewRequest(message, template)} />
        </Section>
      </div>
    </div>
  )
}

/**
 * The messages screen: every email and text message an environment sends, the environment's
 * own wording of each and a preview of what would be sent (ADR 0039, ADR 0042).
 *
 * The wording is part of the settings document, so the screen is a `SettingsFrame`: one
 * draft, one save with `If-Match`, "changed elsewhere" on a stale revision.
 *
 * @returns The screen.
 */
export function MessagesScreen() {
  return (
    <SettingsFrame
      title='Messages'
      description='The words of the emails and text messages this environment sends. A message without wording of its own is sent in the built-in text; the layout, the links and the last line of a text message are always the server’s.'
    >
      {(editor) => <MessageEditor {...editor} />}
    </SettingsFrame>
  )
}
