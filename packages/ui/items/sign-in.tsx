'use client'

import {
  type FirstFactorFormProps,
  type FirstFactorForms,
  type FlowResult,
  type FlowStep,
  firstFactorStrategies,
  formatText,
  rateLimitedAlert,
  StepRenderer,
  type StepScreens,
  type UseSignInResult,
  useClientConfig,
  useFieldErrors,
  useLocalization,
  usePasskeySupport,
  useRetryCountdown,
  useScreenChanged,
  useSignIn,
} from '@tula-tech/react'
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { FormAlert } from '@/components/tula/status'
import { StepCard, type StepCardLevel } from '@/components/tula/step-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface SignInProps {
  /**
   * Called once, when the sign-in has completed and the client holds a session. Go where the
   * user was headed from here (your router's `push`, a `window.location` assignment).
   */
  onComplete?(result: FlowResult): void
  /** Puts an address in the first field to start with. */
  initialEmail?: string
  /** Shows "New here? Create an account" and calls this when it is chosen. */
  onSwitchToSignUp?(): void
  /** Shows "Forgot password?" next to the password and calls this when it is chosen. */
  onForgotPassword?(): void
  /** The level of the title: 1 (the default) for a page of its own, 2 under a page's own h1. */
  headingLevel?: StepCardLevel
  className?: string
}

/** What the screens read from the component that holds them, which a screen's props do not carry. */
interface Options {
  level: StepCardLevel
  className: string | undefined
  forgotPassword: (() => void) | undefined
}

const OptionsContext = createContext<Options>({
  level: 1,
  className: undefined,
  forgotPassword: undefined,
})

/** The fields of each form: a stable list for `useFieldErrors`. */
const EMAIL_FIELDS = ['email'] as const
const PASSWORD_FIELDS = ['password'] as const

/** Quiet text buttons ("Change", "Forgot password?"): the link colour where the theme has one. */
const LINK =
  'h-auto rounded-sm p-0 font-medium text-[color:var(--link,var(--primary))] underline underline-offset-4 hover:bg-transparent hover:no-underline'

/**
 * Sign in with an email address and a password, drawn from the step the server is waiting for.
 *
 * The flow, the session and every security rule live in `@tula-tech/react`; this file is
 * presentation. Edit the markup and the classes freely. A step this file has no screen for is
 * drawn by the package as "not supported", with a way to start again.
 */
export function SignIn(props: SignInProps) {
  const signIn = useSignIn()
  const [email, setEmail] = useState(props.initialEmail ?? '')
  const passkeys = usePasskeySupport()
  const status = signIn.step?.status ?? 'start'
  const focusTitle = useScreenChanged(status)
  const finish = useCompletion(props.onComplete)
  // Every action that can complete the flow reports its answer to `finish`, which tells the
  // app once: a page that shows this component only while signed out takes it away the moment
  // the client is signed in, before an effect could run.
  const flow: UseSignInResult = {
    ...signIn,
    start: async (input) => finish(await signIn.start(input)),
    submitPassword: async (input) => finish(await signIn.submitPassword(input)),
  }
  const options: Options = {
    level: props.headingLevel ?? 1,
    className: props.className,
    forgotPassword: props.onForgotPassword,
  }
  const factor = {
    email,
    signIn: flow,
    focusTitle,
    onForgotPassword: () => props.onForgotPassword?.(),
    onChangeEmail: () => signIn.reset(),
  }
  const identifier = (
    <EmailScreen
      email={email}
      setEmail={setEmail}
      signIn={flow}
      focusTitle={focusTitle}
      onSwitchToSignUp={props.onSwitchToSignUp}
    />
  )
  const screens: StepScreens = {
    needs_identifier: () => identifier,
    needs_password: () => <PasswordScreen {...factor} />,
    needs_first_factor: (step) => {
      // The strategies this file can draw; none means the package's "not supported" screen.
      const drawable = firstFactorStrategies(step.strategies, FIRST_FACTOR_FORMS, {
        link: false,
        passkey: passkeys,
        phone: false,
      })
      const first = drawable[0]
      return first === undefined ? null : <FirstFactorScreen {...factor} strategy={first} />
    },
    complete: () => <SignedInScreen focusTitle={focusTitle} />,
  }
  return (
    <OptionsContext.Provider value={options}>
      <StepRenderer
        step={signIn.step}
        start={identifier}
        screens={screens}
        focusTitle={focusTitle}
        onRestart={() => signIn.reset()}
      />
    </OptionsContext.Provider>
  )
}

/**
 * Tell the app once that the sign-in completed. The callback is read when the answer arrives,
 * not when the action started, so an app that changes it between renders is called as it is now.
 */
function useCompletion(onComplete: SignInProps['onComplete']) {
  const latest = useRef(onComplete)
  latest.current = onComplete
  const told = useRef(false)
  return (next: FlowStep | null): FlowStep | null => {
    if (next?.status === 'complete' && !told.current) {
      told.current = true
      latest.current?.({ userId: next.userId, sessionId: next.sessionId })
    }
    return next
  }
}

/** After a failure, focus moves to the first field marked invalid: the user lands on what to fix. */
function useFocusInvalid(failure: unknown) {
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (failure) {
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [failure])
  return form
}

function EmailScreen(props: {
  email: string
  setEmail(value: string): void
  signIn: UseSignInResult
  focusTitle: boolean
  onSwitchToSignUp: (() => void) | undefined
}) {
  const t = useLocalization()
  const { level, className } = useContext(OptionsContext)
  const appName = useClientConfig()?.app.name
  const { signIn, email } = props
  const [missing, setMissing] = useState<{ message: string } | null>(null)
  const placed = useFieldErrors(signIn.error, EMAIL_FIELDS)
  const wait = useRetryCountdown(signIn.error)
  const form = useFocusInvalid(missing ?? signIn.error)
  const submit = () => {
    if (email.trim() === '') {
      setMissing({ message: t.common.required })
      return
    }
    setMissing(null)
    void signIn.start({ identifier: email.trim() })
  }
  return (
    <StepCard
      title={t.signIn.title}
      description={appName ? formatText(t.signIn.subtitle, { appName }) : t.signIn.subtitleNoApp}
      focusTitle={props.focusTitle}
      level={level}
      className={className}
      footer={
        props.onSwitchToSignUp ? (
          <span>
            {t.signIn.noAccount}{' '}
            <Button type='button' variant='link' className={LINK} onClick={props.onSwitchToSignUp}>
              {t.signIn.signUpLink}
            </Button>
          </span>
        ) : undefined
      }
    >
      <form
        ref={form}
        noValidate
        className='grid gap-5'
        onSubmit={(event) => onSubmit(event, signIn.isPending || wait > 0, submit)}
      >
        <FormAlert {...rateLimitedAlert(placed.form, wait, t)} />
        <Field
          label={t.signIn.emailLabel}
          name='email'
          type='email'
          inputMode='email'
          autoComplete='username'
          value={email}
          onValue={(value) => {
            props.setEmail(value)
            setMissing(null)
          }}
          errors={missing ? [missing.message] : placed.fields.email}
        />
        <SubmitButton pending={signIn.isPending} blocked={wait > 0}>
          {t.signIn.continue}
        </SubmitButton>
      </form>
    </StepCard>
  )
}

function PasswordScreen(props: FirstFactorFormProps) {
  const t = useLocalization()
  const { level, className, forgotPassword } = useContext(OptionsContext)
  const { signIn, email } = props
  const [password, setPassword] = useState('')
  const [missing, setMissing] = useState<{ message: string } | null>(null)
  const placed = useFieldErrors(signIn.error, PASSWORD_FIELDS, 'password')
  const wait = useRetryCountdown(signIn.error)
  const form = useFocusInvalid(missing ?? signIn.error)
  const submit = async () => {
    if (password === '') {
      setMissing({ message: t.common.required })
      return
    }
    setMissing(null)
    await signIn.submitPassword({ password })
    // Whatever the answer, the password has done its job: it is not kept in state.
    setPassword('')
  }
  return (
    <StepCard
      title={t.signIn.passwordTitle}
      focusTitle={props.focusTitle}
      level={level}
      className={className}
    >
      <div className='flex items-center justify-between gap-3 rounded-lg border bg-muted/40 py-2 pr-3 pl-3.5 text-sm'>
        <span className='min-w-0 truncate font-medium'>{email}</span>
        <Button type='button' variant='link' className={LINK} onClick={props.onChangeEmail}>
          {t.signIn.changeEmail}
        </Button>
      </div>
      <form
        ref={form}
        noValidate
        className='grid gap-5'
        onSubmit={(event) => onSubmit(event, signIn.isPending || wait > 0, submit)}
      >
        <FormAlert {...rateLimitedAlert(placed.form, wait, t)} />
        {/* For password managers: the account this password belongs to. Not shown, not focusable. */}
        <input
          className='sr-only'
          type='text'
          name='username'
          autoComplete='username'
          value={email}
          readOnly
          tabIndex={-1}
          aria-hidden='true'
        />
        <Field
          label={t.signIn.passwordLabel}
          name='password'
          autoComplete='current-password'
          secret
          value={password}
          onValue={(value) => {
            setPassword(value)
            setMissing(null)
          }}
          errors={missing ? [missing.message] : placed.fields.password}
          action={
            forgotPassword ? (
              <Button type='button' variant='link' className={LINK} onClick={forgotPassword}>
                {t.signIn.forgotPassword}
              </Button>
            ) : undefined
          }
        />
        <SubmitButton pending={signIn.isPending} blocked={wait > 0}>
          {t.signIn.submit}
        </SubmitButton>
      </form>
    </StepCard>
  )
}

/** The first factors this file can draw, by strategy. */
const FIRST_FACTOR_FORMS: FirstFactorForms = { password: PasswordScreen }

/** A `needs_first_factor` step, drawn by the form of the strategy chosen for it. */
function FirstFactorScreen(props: FirstFactorFormProps & { strategy: keyof FirstFactorForms }) {
  const { strategy, ...form } = props
  const Form = FIRST_FACTOR_FORMS[strategy]
  return Form ? <Form {...form} /> : null
}

function SignedInScreen(props: { focusTitle: boolean }) {
  const t = useLocalization()
  const { level, className } = useContext(OptionsContext)
  return (
    <StepCard
      title={t.signIn.signedIn}
      focusTitle={props.focusTitle}
      level={level}
      className={className}
    />
  )
}

/** A form that sends nothing by itself: while an action is pending or refused, Enter does nothing. */
function onSubmit(event: FormEvent, blocked: boolean, run: () => void) {
  event.preventDefault()
  if (!blocked) {
    run()
  }
}

/** The submit button: full width, ink, and `aria-disabled` while pending so that it keeps focus. */
function SubmitButton(props: { pending: boolean; blocked: boolean; children: ReactNode }) {
  const inert = props.pending || props.blocked
  return (
    <Button
      type='submit'
      aria-disabled={inert || undefined}
      aria-busy={props.pending || undefined}
      onClick={(event) => {
        if (inert) {
          event.preventDefault()
        }
      }}
      className='h-11 w-full gap-2 rounded-lg text-sm font-medium transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out hover:bg-primary/90 motion-reduce:transition-none motion-safe:active:scale-[0.99] @sm/step:h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-70'
    >
      {props.pending ? (
        <svg
          aria-hidden='true'
          viewBox='0 0 16 16'
          className='size-4 animate-spin motion-reduce:animate-none'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
        >
          <path d='M8 2a6 6 0 1 0 6 6' />
        </svg>
      ) : null}
      {props.children}
    </Button>
  )
}

/**
 * A labelled input with its error wired up for assistive technology. `secret` makes it a
 * password with a show/hide button; `action` sits at the end of the label's row but comes after
 * the input in the document, so that Tab reaches the field first.
 */
function Field(props: {
  label: string
  name: string
  value: string
  onValue(value: string): void
  errors: readonly string[] | undefined
  type?: 'email' | 'text'
  inputMode?: 'email'
  autoComplete: string
  secret?: boolean
  action?: ReactNode
}) {
  const t = useLocalization()
  const id = useId()
  const errorId = `${id}-error`
  const [visible, setVisible] = useState(false)
  const errors = props.errors ?? []
  const invalid = errors.length > 0
  return (
    <div className='grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2'>
      <Label htmlFor={id} className='col-start-1 row-start-1 text-sm font-medium leading-none'>
        {props.label}
      </Label>
      <div className='relative col-span-2 row-start-2'>
        <Input
          id={id}
          name={props.name}
          type={props.secret ? (visible ? 'text' : 'password') : (props.type ?? 'text')}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete}
          autoCapitalize='none'
          autoCorrect='off'
          spellCheck={false}
          value={props.value}
          onChange={(event) => props.onValue(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className={cn(
            'h-11 rounded-lg px-3.5 text-base transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none @sm/step:h-10 @sm/step:text-sm',
            props.secret && 'pr-11'
          )}
        />
        {props.secret ? (
          <Button
            type='button'
            variant='ghost'
            aria-label={t.password.show}
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
            className='absolute top-1/2 right-1 size-9 -translate-y-1/2 rounded-md p-0 text-muted-foreground hover:text-foreground @sm/step:size-8'
          >
            <svg
              aria-hidden='true'
              viewBox='0 0 16 16'
              className='size-4'
              fill='none'
              stroke='currentColor'
              strokeWidth='1.5'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z' />
              <circle cx='8' cy='8' r='2' />
              {visible ? <path d='M2.5 13.5 13.5 2.5' /> : null}
            </svg>
          </Button>
        ) : null}
      </div>
      {invalid ? (
        <div id={errorId} role='alert' className='col-span-2 row-start-3 text-sm text-destructive'>
          {errors.length === 1 ? (
            errors[0]
          ) : (
            <ul className='grid list-disc gap-0.5 pl-4'>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {props.action ? <div className='col-start-2 row-start-1 text-sm'>{props.action}</div> : null}
    </div>
  )
}
