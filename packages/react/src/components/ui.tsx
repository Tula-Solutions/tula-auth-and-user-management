import type { PasswordCheck } from '@tula/core'
import {
  createContext,
  type FormEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type Appearance,
  type ElementProps,
  elementProps,
  mergeAppearance,
  rootAttributes,
} from '../appearance'
import { useTulaContext } from '../context'
import { formatText, type TulaLocalization } from '../localization'
import { CheckIcon, CircleIcon, CloseIcon, EyeIcon, EyeOffIcon, LockIcon } from './icons'

/** The level of a component's title; its section titles are one level below. */
export type HeadingLevel = 1 | 2 | 3

interface Ui {
  /** Builds a part's class name and `data-tula-element`. */
  el: ElementProps
  /** The strings. */
  t: TulaLocalization
  /** The level of the component's title. */
  headingLevel: HeadingLevel
}

const UiContext = createContext<Ui | null>(null)

/** @returns What the nearest {@link Root} provides to the parts inside it. */
export function useUi(): Ui {
  const ui = useContext(UiContext)
  if (!ui) {
    throw new Error('@tula/react: internal component rendered outside its root.')
  }
  return ui
}

/**
 * The outermost element of every component: carries the `tula-root` class the stylesheet
 * hangs its tokens on, the theme as inline custom properties, and a forced colour scheme.
 */
export function Root(props: {
  appearance: Appearance | undefined
  headingLevel?: HeadingLevel
  children: ReactNode
}) {
  const context = useTulaContext()
  const appearance = useMemo(
    () => mergeAppearance(context.appearance, props.appearance),
    [context.appearance, props.appearance]
  )
  const ui = useMemo<Ui>(
    () => ({
      el: elementProps(appearance),
      t: context.localization,
      headingLevel: props.headingLevel ?? 1,
    }),
    [appearance, context.localization, props.headingLevel]
  )
  return (
    <UiContext.Provider value={ui}>
      <div {...ui.el('root')} {...rootAttributes(appearance)}>
        {props.children}
      </div>
    </UiContext.Provider>
  )
}

/** A heading at the component's level plus `offset`, focusable from script (not by Tab). */
export function Heading(
  props: {
    offset?: 0 | 1
    headingRef?: RefObject<HTMLHeadingElement | null>
  } & HTMLAttributes<HTMLHeadingElement>
) {
  const { headingLevel } = useUi()
  const { offset = 0, headingRef, ...rest } = props
  const Tag = `h${Math.min(6, headingLevel + offset)}` as 'h1'
  return <Tag ref={headingRef} tabIndex={-1} {...rest} />
}

/**
 * One screen of a flow: a titled card. When `focusTitle` is set the title takes focus as the
 * card appears, so that a screen-reader user hears the new step and a keyboard user continues
 * from its top. The first screen of a component does not take focus: the page owns that.
 */
export function Card(props: {
  title: string
  subtitle?: ReactNode
  focusTitle?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  const { el, t } = useUi()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const { focusTitle } = props
  useEffect(() => {
    if (focusTitle) {
      title.current?.focus()
    }
  }, [focusTitle])
  return (
    <section {...el('card')} aria-labelledby={titleId}>
      <header {...el('header')}>
        <Heading {...el('title')} id={titleId} headingRef={title}>
          {props.title}
        </Heading>
        {props.subtitle ? <p {...el('subtitle')}>{props.subtitle}</p> : null}
      </header>
      {props.children}
      {props.footer ? <div {...el('footer')}>{props.footer}</div> : null}
      <p {...el('branding')}>
        <LockIcon />
        {t.common.securedBy}
      </p>
    </section>
  )
}

/**
 * A form that sends nothing by itself: `onSubmit` runs the action. After a failure, focus
 * moves to the first field marked invalid so the user lands on what to fix; the message itself
 * is announced by its `role="alert"`.
 */
export function Form(props: {
  onSubmit(): void
  /** Changes when a new failure arrives (the error object, or the local validation result). */
  failure: unknown
  /** While set, submitting (Enter in a field) does nothing: an action is pending or refused. */
  blocked?: boolean
  children: ReactNode
}) {
  const { el } = useUi()
  const form = useRef<HTMLFormElement>(null)
  const { failure } = props
  useEffect(() => {
    if (failure) {
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [failure])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!props.blocked) {
      props.onSubmit()
    }
  }
  return (
    <form {...el('form')} ref={form} onSubmit={submit} noValidate>
      {props.children}
    </form>
  )
}

interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'className' | 'id'> {
  label: string
  value: string
  onValue(value: string): void
  /** Messages shown under the field; any makes the field invalid. */
  errors?: string[]
  hint?: string
  /** Rendered inside the field's box after the input, e.g. the show/hide button. */
  trailing?: ReactNode
  /** Ids of more elements that describe the input (the password checklist). */
  describedBy?: string
  /** Which part the input is: an ordinary field or the one-time code. */
  part?: 'input' | 'codeInput'
  children?: ReactNode
}

/** A labelled input with its hint and errors wired up for assistive technology. */
export function TextField(props: TextFieldProps) {
  const { el } = useUi()
  const {
    label,
    value,
    onValue,
    errors = [],
    hint,
    trailing,
    describedBy,
    part = 'input',
    children,
    ...input
  } = props
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const invalid = errors.length > 0
  const description = [hint ? hintId : null, describedBy, invalid ? errorId : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div {...el('field', invalid && 'tula-is-invalid')}>
      <div className='tula-label-row'>
        <label {...el('label')} htmlFor={id}>
          {label}
        </label>
      </div>
      <div {...el('inputGroup')}>
        <input
          {...input}
          {...el(part)}
          id={id}
          value={value}
          onChange={(event) => onValue(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={description === '' ? undefined : description}
        />
        {trailing}
      </div>
      {hint ? (
        <p {...el('hint')} id={hintId}>
          {hint}
        </p>
      ) : null}
      {invalid ? (
        <div {...el('fieldError')} id={errorId} role='alert'>
          {errors.length === 1 ? (
            errors[0]
          ) : (
            <ul>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {children}
    </div>
  )
}

/** An email address field. */
export function EmailField(props: Omit<TextFieldProps, 'type'>) {
  return (
    <TextField
      type='email'
      inputMode='email'
      autoCapitalize='none'
      autoCorrect='off'
      spellCheck={false}
      {...props}
    />
  )
}

/**
 * A password field with a show/hide button and, when `checks` is given, the live checklist.
 *
 * The value lives in the caller's state only while the form is on screen; the field itself
 * keeps nothing.
 */
export function PasswordField(
  props: Omit<TextFieldProps, 'type' | 'trailing' | 'describedBy'> & {
    autoComplete: 'current-password' | 'new-password'
    /** The rules to show under the field, from `usePasswordChecklist`. */
    checks?: PasswordCheck[]
    /**
     * The password history rule, where a password replaces one (a change, a reset) and the
     * policy remembers any. Only the server can judge it, so it is never drawn as met.
     */
    history?: PasswordHistoryRule | null
  }
) {
  const { el, t } = useUi()
  const [visible, setVisible] = useState(false)
  const checklistId = useId()
  const { checks, history, children, ...field } = props
  // "No more than N characters" is only worth a line once it is broken.
  const shown = (checks ?? []).filter((check) => check.rule !== 'max_length' || !check.passed)
  return (
    <TextField
      {...field}
      type={visible ? 'text' : 'password'}
      autoCapitalize='none'
      autoCorrect='off'
      spellCheck={false}
      describedBy={shown.length > 0 ? checklistId : undefined}
      trailing={
        <button
          type='button'
          {...el('passwordToggle')}
          aria-label={t.password.show}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      }
    >
      {shown.length > 0 ? (
        <Checklist
          id={checklistId}
          checks={shown}
          typed={props.value !== ''}
          history={history ?? null}
        />
      ) : null}
      {children}
    </TextField>
  )
}

/**
 * The checklist's line for the password history (`password.history` of the policy).
 *
 * A browser never has the user's earlier passwords, so the line has two states and neither is
 * "met": waiting for the server, and refused by it.
 */
export interface PasswordHistoryRule {
  /** The policy's `history`: how many of the last passwords, the current one included. */
  count: number
  /** The server refused the password that is in the field as one of them (`password.reused`). */
  refused: boolean
}

/**
 * The history line for a password field, from the policy and the last answer.
 *
 * @param policy - The environment's policy, or `null` until it is known.
 * @param error - What the last submit failed with, if it did.
 * @param edited - Whether the field was changed since that submit: a refusal is about the
 *   password that was sent, not the one being typed now.
 * @returns The line, or `null` where the policy remembers no passwords.
 */
export function passwordHistoryRule(
  policy: { history: number } | null,
  error: { code: string; errors: readonly { code: string }[] } | null,
  edited: boolean
): PasswordHistoryRule | null {
  if (!policy || policy.history < 1) {
    return null
  }
  const reused =
    error !== null &&
    (error.code === 'password.reused' ||
      error.errors.some((problem) => problem.code === 'password.reused'))
  return { count: policy.history, refused: reused && !edited }
}

/** How many segments the strength bar has. */
const BAR_SEGMENTS = 4

function Checklist(props: {
  id: string
  checks: PasswordCheck[]
  typed: boolean
  history: PasswordHistoryRule | null
}) {
  const { el, t } = useUi()
  const { checks, typed, history } = props
  const passed = checks.filter((check) => check.passed).length
  const filled = typed ? Math.floor((passed / checks.length) * BAR_SEGMENTS) : 0
  return (
    <div className='tula-password-rules' id={props.id}>
      {/* The bar repeats what the list says, in colour: hidden from assistive technology. */}
      <div {...el('strengthBar')} aria-hidden='true'>
        {Array.from({ length: BAR_SEGMENTS }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, order never changes
          <span key={index} data-filled={index < filled || undefined} />
        ))}
      </div>
      <ul {...el('checklist')} aria-label={t.password.requirements}>
        {checks.map((check) => {
          const met = typed && check.passed
          return (
            <li key={check.rule} {...el('checklistItem', met && 'tula-is-met')} data-met={met}>
              {met ? <CheckIcon /> : <CircleIcon />}
              <span>
                {/* The state as text, not only as colour and icon. */}
                <span className='tula-visually-hidden'>
                  {met ? t.password.met : t.password.unmet}:{' '}
                </span>
                {formatText(
                  Object.hasOwn(t.password.rules, check.rule)
                    ? t.password.rules[check.rule]
                    : check.rule,
                  check.params ?? {}
                )}
              </span>
            </li>
          )
        })}
        {history ? (
          // Never `tula-is-met`: the server has not said so, and when it has, the form is gone.
          <li
            {...el('checklistItem', history.refused && 'tula-is-failed')}
            data-met={false}
            data-state={history.refused ? 'failed' : 'pending'}
          >
            {history.refused ? <CloseIcon /> : <CircleIcon />}
            <span>
              <span className='tula-visually-hidden'>
                {history.refused ? t.password.unmet : t.password.checkedOnSave}:{' '}
              </span>
              {history.count === 1
                ? t.password.historyCurrent
                : formatText(t.password.history, { count: history.count })}
              {history.refused ? null : (
                <span aria-hidden='true'> ({t.password.checkedOnSave})</span>
              )}
            </span>
          </li>
        ) : null}
      </ul>
      <output className='tula-visually-hidden'>
        {typed ? formatText(t.password.summary, { passed, total: checks.length }) : ''}
      </output>
    </div>
  )
}

/**
 * A button that can be pending. While pending (or disabled) it keeps its label, its place in
 * the tab order and focus: it is `aria-disabled`, not `disabled`, and ignores clicks.
 */
export function Button(props: {
  kind?: 'primary' | 'secondary' | 'danger' | 'link'
  type?: 'button' | 'submit'
  pending?: boolean
  disabled?: boolean
  onClick?(): void
  'aria-label'?: string
  /** The id of text that is read with the button: a consequence said before the click. */
  'aria-describedby'?: string
  children: ReactNode
}) {
  const { el } = useUi()
  const { kind = 'primary', type = 'button', pending = false, disabled = false, onClick } = props
  const inert = pending || disabled
  const click = (event: MouseEvent) => {
    if (inert) {
      event.preventDefault()
      return
    }
    onClick?.()
  }
  return (
    <button
      type={type}
      {...el(`${kind}Button`, pending && 'tula-is-pending')}
      aria-disabled={inert || undefined}
      aria-busy={pending || undefined}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      onClick={click}
    >
      {pending ? <span {...el('spinner')} aria-hidden='true' /> : null}
      <span>{props.children}</span>
    </button>
  )
}

/** The message above a form for a failure that is not about one field. Announced at once. */
export function FormError(props: { message: string | null; detail?: string | null }) {
  const { el } = useUi()
  if (!props.message) {
    return null
  }
  return (
    <div {...el('error')} role='alert'>
      <p>{props.message}</p>
      {/* A countdown changes every second; it is read with the alert once, not re-announced. */}
      {props.detail ? <p aria-live='off'>{props.detail}</p> : null}
    </div>
  )
}

/**
 * A quiet message, announced politely (an `<output>`, never an alert).
 *
 * @param props.message - What to say; `null` keeps the live region in the page, empty.
 * @param props.tone - `success` (the default) for a confirmation of something done ("A new
 *   code is on its way."), drawn in the success colour. `neutral` for something that is
 *   neither done nor wrong (a passkey dialog the user dismissed), drawn in the muted text
 *   colour: nothing succeeded, so it must not look as if something had.
 */
export function Status(props: { message: string | null; tone?: 'success' | 'neutral' }) {
  const { el } = useUi()
  return (
    <output
      {...el(
        'status',
        !props.message && 'tula-is-empty',
        props.tone === 'neutral' && 'tula-is-neutral'
      )}
    >
      {props.message ?? ''}
    </output>
  )
}

/**
 * Whether a screen is the first one its component drew. Later screens move focus to their
 * title; the first leaves focus where the page put it.
 *
 * @param screen - A key naming the current screen.
 * @returns `true` once the component has moved on from its first screen.
 */
export function useScreenChanged(screen: string): boolean {
  const first = useRef(screen)
  const moved = useRef(false)
  if (screen !== first.current) {
    moved.current = true
  }
  return moved.current
}
