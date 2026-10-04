import { type ComponentProps, type ReactNode, useId } from 'react'
import { cn } from '~/lib/utils'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'
import { Switch } from './ui/switch'

/** What {@link Field} hands the control it labels. */
export interface FieldControlProps {
  id: string
  'aria-invalid': true | undefined
  'aria-describedby': string | undefined
}

/**
 * A label, a control, an optional hint and the field's error, wired together: the error is
 * announced (`role="alert"`) and associated with the control (`aria-describedby`).
 *
 * @param props - `label`, optional `hint` and `error`, and a render function for the control.
 * @returns The field.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string
  children: (control: FieldControlProps) => ReactNode
  className?: string
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
      })}
      {hint ? (
        <p id={hintId} className='text-xs text-muted-foreground'>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Props shared by the field shortcuts. */
interface LabelledProps {
  label: ReactNode
  hint?: ReactNode
  error?: string
}

/**
 * A labelled text input.
 *
 * @param props - {@link Field}'s props and the input's own.
 * @returns The field.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  ...input
}: LabelledProps & ComponentProps<typeof Input>) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(control) => <Input className='bg-field' {...control} {...input} />}
    </Field>
  )
}

/**
 * A labelled native select: the platform's own control, which works with a keyboard, a
 * screen reader and a phone without any script.
 *
 * @param props - {@link Field}'s props, the select's own, and its `<option>`s as children.
 * @returns The field.
 */
export function SelectField({
  label,
  hint,
  error,
  className,
  children,
  ...select
}: LabelledProps & ComponentProps<typeof NativeSelect>) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(control) => (
        // The primitive's wrapper is as wide as its text; in a form it fills its column.
        <div className='[&>[data-slot=native-select-wrapper]]:w-full'>
          <NativeSelect className='w-full bg-field' {...control} {...select}>
            {children}
          </NativeSelect>
        </div>
      )}
    </Field>
  )
}

/**
 * A switch with its label and description on one row (Design.pdf page 6, "Sign-in methods").
 *
 * @param props - `label`, optional `description`, `checked` and `onChange`.
 * @returns The row.
 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className='flex items-center justify-between gap-4 border-b py-3 last:border-b-0'>
      <div className='flex min-w-0 flex-col'>
        <Label htmlFor={id} className='text-sm font-medium'>
          {label}
        </Label>
        {description ? (
          <span id={`${id}-description`} className='text-sm text-muted-foreground'>
            {description}
          </span>
        ) : null}
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <span aria-hidden='true' className='w-7 text-right text-xs text-muted-foreground'>
          {checked ? 'On' : 'Off'}
        </span>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-describedby={description ? `${id}-description` : undefined}
        />
      </div>
    </div>
  )
}
