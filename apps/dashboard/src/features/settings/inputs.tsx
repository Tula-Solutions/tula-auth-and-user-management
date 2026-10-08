import { type FormEvent, type KeyboardEvent, useId, useState } from 'react'
import { ActionButton } from '~/components/action-button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'

/**
 * Read a whole number from a number input.
 *
 * @param value - The input's text.
 * @returns The number; 0 for an empty or unreadable input (a number input must always hold a
 *   number, and where 0 is not allowed the server says so with a field error).
 */
export function wholeNumber(value: string): number {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed
}

/**
 * Read an optional whole number: an empty input means "none".
 *
 * @param value - The input's text.
 * @returns The number, or `null` for an empty input.
 */
export function numberOrNull(value: string): number | null {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? null : parsed
}

/**
 * Read an optional text value: an empty input means "none".
 *
 * @param value - The input's text.
 * @returns The trimmed text, or `null` when empty.
 */
export function textOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Props of {@link ListEditor}. */
export interface ListEditorProps {
  /** What the list holds ("Allowed origins"). */
  label: string
  /** One entry, for the buttons' names ("origin"). */
  itemName: string
  hint?: string
  values: string[]
  onChange: (values: string[]) => void
  /** Check a new entry; returns the problem or `undefined`. */
  validate: (value: string) => string | undefined
  /** The server's error for the list. */
  error?: string
  placeholder?: string
}

/**
 * Edit a list of strings (origins, redirect URLs): each entry with its own "take out" button,
 * and one input to add another. A new entry is checked before it joins the list.
 *
 * @param props - See {@link ListEditorProps}.
 * @returns The editor.
 */
export function ListEditor({
  label,
  itemName,
  hint,
  values,
  onChange,
  validate,
  error,
  placeholder,
}: ListEditorProps) {
  const id = useId()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string>()

  function add(event?: FormEvent | KeyboardEvent) {
    event?.preventDefault()
    const value = text.trim()
    const found =
      value === ''
        ? `Enter the ${itemName} to add.`
        : values.includes(value)
          ? 'That one is already in the list.'
          : validate(value)
    setProblem(found)
    if (found === undefined) {
      onChange([...values, value])
      setText('')
    }
  }

  const shown = problem ?? error
  return (
    <div className='flex flex-col gap-2'>
      <Label htmlFor={id}>{label}</Label>
      {values.length === 0 ? (
        <p className='text-sm text-muted-foreground'>None yet.</p>
      ) : (
        <ul className='flex flex-col gap-1.5' aria-label={label}>
          {values.map((value) => (
            <li
              key={value}
              className='flex items-center justify-between gap-3 rounded-md border px-3 py-1.5 text-sm'
            >
              <code className='min-w-0 break-all'>{value}</code>
              <ActionButton
                variant='ghost'
                size='sm'
                onClick={() => onChange(values.filter((entry) => entry !== value))}
                aria-label={`Take out ${value}`}
              >
                Take out
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      <div className='flex flex-wrap gap-2'>
        <Input
          id={id}
          className='min-w-0 flex-1 bg-field'
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          // Enter adds the entry instead of submitting the whole settings form.
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add(event)
            }
          }}
          aria-invalid={shown ? true : undefined}
          aria-describedby={`${id}-hint ${id}-error`}
          autoComplete='off'
          spellCheck={false}
        />
        <ActionButton variant='outline' onClick={() => add()}>
          Add {itemName}
        </ActionButton>
      </div>
      <p id={`${id}-hint`} className='text-xs text-muted-foreground'>
        {hint}
      </p>
      <p id={`${id}-error`} role='alert' className='text-sm text-destructive'>
        {shown}
      </p>
    </div>
  )
}
