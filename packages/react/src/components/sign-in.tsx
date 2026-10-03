import type { FirstFactorStrategy, FlowStep } from '@tula/core'
import { type ComponentType, type MouseEvent, type ReactNode, useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { useClientConfig, usePasswordChecklist } from '../hooks/use-password-checklist'
import { type UseResetPasswordResult, useResetPassword } from '../hooks/use-reset-password'
import { type UseSignInResult, useSignIn } from '../hooks/use-sign-in'
import { formatText } from '../localization'
import { safeUrl } from '../navigation'
import {
  CODE_LENGTH,
  CodeField,
  type FlowResult,
  ResendButton,
  SignedInNotice,
  UnsupportedScreen,
  useCompletion,
  useRetryAfter,
  VerificationScreen,
} from './flow-screens'
import { fieldResolver, formatDuration, placeErrors } from './form-errors'
import {
  Button,
  Card,
  EmailField,
  Form,
  FormError,
  type HeadingLevel,
  PasswordField,
  Root,
  Status,
  useScreenChanged,
  useUi,
} from './ui'

/**
 * Props of {@link SignIn}.
 *
 * @example
 * ```tsx
 * <SignIn signUpUrl='/sign-up' afterSignInUrl='/app' />
 * ```
 */
export interface SignInProps {
  /** Where `<SignUp>` lives; shows "New here? Create an account". Overrides the provider's. */
  signUpUrl?: string
  /** Called instead of following `signUpUrl`, for an app that swaps the two in place. */
  onSwitchToSignUp?: () => void
  /** Where to go once signed in. Overrides the provider's `afterSignInUrl`. */
  afterSignInUrl?: string
  /** Called once signed in, instead of navigating to `afterSignInUrl`. */
  onComplete?: (result: FlowResult) => void
  /** Puts an address in the email field to start with. */
  initialEmail?: string
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the card's title. Defaults to 1; use 2 when the page has its own `<h1>`. */
  headingLevel?: HeadingLevel
}

/** A link between `<SignIn>` and `<SignUp>`: a real link when there is a URL, else a button. */
export function SwitchLink(props: {
  prompt: string
  label: string
  url: string | undefined
  onSwitch?: () => void
}) {
  const { el } = useUi()
  const { navigation } = useTulaContext()
  const { url, onSwitch } = props
  // Validated against a dummy base: only the scheme matters here, and rendering must not need
  // `window`. A URL that is refused renders no link at all.
  const href = url !== undefined && safeUrl(url, 'http://localhost') !== null ? url : undefined
  if (href === undefined && !onSwitch) {
    return null
  }
  const follow = (event: MouseEvent) => {
    if (onSwitch) {
      event.preventDefault()
      onSwitch()
    } else if (
      navigation.navigate &&
      href !== undefined &&
      !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    ) {
      event.preventDefault()
      navigation.navigate(href)
    }
  }
  return (
    <p className='tula-switch'>
      {props.prompt}{' '}
      {href !== undefined ? (
        <a {...el('link')} href={href} onClick={follow}>
          {props.label}
        </a>
      ) : (
        <Button kind='link' onClick={onSwitch}>
          {props.label}
        </Button>
      )}
    </p>
  )
}

/** What a first-factor form gets. */
interface FirstFactorProps {
  email: string
  signIn: UseSignInResult
  focusTitle: boolean
  onForgotPassword(): void
  onChangeEmail(): void
}

/**
 * The first factors this version can draw, by strategy. A later step adds a method by adding
 * its form here (magic link, email code, passkeys, OAuth); a strategy with no entry is skipped.
 */
const FIRST_FACTOR_FORMS: Partial<Record<FirstFactorStrategy, ComponentType<FirstFactorProps>>> = {
  password: PasswordScreen,
}

function supportedStrategies(strategies: readonly string[]): FirstFactorStrategy[] {
  return strategies.filter((strategy): strategy is FirstFactorStrategy =>
    Object.hasOwn(FIRST_FACTOR_FORMS, strategy)
  )
}

function IdentifierScreen(props: {
  email: string
  setEmail(value: string): void
  signIn: UseSignInResult
  focusTitle: boolean
  footer: ReactNode
}) {
  const { t } = useUi()
  const { signIn, email } = props
  const appName = useClientConfig()?.app.name
  const [missing, setMissing] = useState<{ message: string } | null>(null)
  const limits = useRetryAfter<'start'>(signIn.error)
  const placed = placeErrors(signIn.error, fieldResolver(['email']))
  const wait = limits.secondsLeft('start')
  const submit = () => {
    if (email.trim() === '') {
      setMissing({ message: t.common.required })
      return
    }
    setMissing(null)
    limits.mark('start')
    void signIn.start({ identifier: email.trim() })
  }
  return (
    <Card
      title={t.signIn.title}
      subtitle={appName ? formatText(t.signIn.subtitle, { appName }) : t.signIn.subtitleNoApp}
      focusTitle={props.focusTitle}
      footer={props.footer}
    >
      <Form
        onSubmit={submit}
        failure={missing ?? signIn.error}
        blocked={signIn.isPending || wait > 0}
      >
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        <EmailField
          label={t.signIn.emailLabel}
          name='email'
          autoComplete='username'
          value={email}
          onValue={(value) => {
            props.setEmail(value)
            setMissing(null)
          }}
          errors={missing ? [missing.message] : placed.fields.email}
          required
        />
        <Button type='submit' pending={signIn.isPending} disabled={wait > 0}>
          {t.signIn.continue}
        </Button>
      </Form>
    </Card>
  )
}

function PasswordScreen(props: FirstFactorProps) {
  const { el, t } = useUi()
  const { signIn, email } = props
  const [password, setPassword] = useState('')
  const [missing, setMissing] = useState<{ message: string } | null>(null)
  const limits = useRetryAfter<'submit'>(signIn.error)
  const placed = placeErrors(signIn.error, fieldResolver(['password'], 'password'))
  const wait = limits.secondsLeft('submit')
  const submit = async () => {
    if (password === '') {
      setMissing({ message: t.common.required })
      return
    }
    setMissing(null)
    limits.mark('submit')
    await signIn.submitPassword({ password })
    // Whatever the answer, the password has done its job: it is not kept in state.
    setPassword('')
  }
  return (
    <Card title={t.signIn.passwordTitle} focusTitle={props.focusTitle}>
      <p {...el('identity')}>
        <span>{email}</span>
        <Button kind='link' onClick={props.onChangeEmail}>
          {t.signIn.changeEmail}
        </Button>
      </p>
      <Form
        onSubmit={submit}
        failure={missing ?? signIn.error}
        blocked={signIn.isPending || wait > 0}
      >
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        {/* For password managers: the account this password belongs to. Not shown, not focusable. */}
        <input
          className='tula-visually-hidden'
          type='text'
          name='username'
          autoComplete='username'
          value={email}
          readOnly
          tabIndex={-1}
          aria-hidden='true'
        />
        <PasswordField
          label={t.signIn.passwordLabel}
          name='password'
          autoComplete='current-password'
          value={password}
          onValue={(value) => {
            setPassword(value)
            setMissing(null)
          }}
          errors={missing ? [missing.message] : placed.fields.password}
          required
        >
          {/* After the input in the document, so that Tab goes from the title straight to the
              password and reaches this on the way to the button, not before the field. */}
          <div className='tula-field-action'>
            <Button kind='link' onClick={props.onForgotPassword}>
              {t.signIn.forgotPassword}
            </Button>
          </div>
        </PasswordField>
        <Button type='submit' pending={signIn.isPending} disabled={wait > 0}>
          {t.signIn.submit}
        </Button>
      </Form>
    </Card>
  )
}

/** `needs_first_factor`: one form per strategy the server offered that this version knows. */
function FirstFactorScreen(
  props: FirstFactorProps & { strategies: readonly string[]; onRestart(): void }
) {
  const { strategies, onRestart, ...form } = props
  const known = supportedStrategies(strategies)
  const [first] = known
  const Screen = first ? FIRST_FACTOR_FORMS[first] : undefined
  if (!Screen) {
    return <UnsupportedScreen focusTitle={props.focusTitle} onRestart={onRestart} />
  }
  return <Screen {...form} />
}

function ResetStartScreen(props: {
  email: string
  setEmail(value: string): void
  reset: UseResetPasswordResult
  focusTitle: boolean
  onBack(): void
}) {
  const { t } = useUi()
  const { reset, email } = props
  const [missing, setMissing] = useState<{ message: string } | null>(null)
  const limits = useRetryAfter<'start'>(reset.error)
  const placed = placeErrors(reset.error, fieldResolver(['email']))
  const wait = limits.secondsLeft('start')
  const submit = () => {
    if (email.trim() === '') {
      setMissing({ message: t.common.required })
      return
    }
    setMissing(null)
    limits.mark('start')
    void reset.start({ email: email.trim() })
  }
  return (
    <Card
      title={t.resetPassword.title}
      subtitle={t.resetPassword.subtitle}
      focusTitle={props.focusTitle}
      footer={
        <Button kind='link' onClick={props.onBack}>
          {t.resetPassword.backToSignIn}
        </Button>
      }
    >
      <Form
        onSubmit={submit}
        failure={missing ?? reset.error}
        blocked={reset.isPending || wait > 0}
      >
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        <EmailField
          label={t.resetPassword.emailLabel}
          name='email'
          autoComplete='username'
          value={email}
          onValue={(value) => {
            props.setEmail(value)
            setMissing(null)
          }}
          errors={missing ? [missing.message] : placed.fields.email}
          required
        />
        <Button type='submit' pending={reset.isPending} disabled={wait > 0}>
          {t.resetPassword.sendCode}
        </Button>
      </Form>
    </Card>
  )
}

/** `needs_new_password`: the emailed code and the new password, sent together. */
function NewPasswordScreen(props: {
  email: string
  destination: string
  reset: UseResetPasswordResult
  focusTitle: boolean
  onBack(): void
}) {
  const { t } = useUi()
  const { reset, email } = props
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [local, setLocal] = useState<{ code?: string; password?: string } | null>(null)
  const [resent, setResent] = useState(false)
  const [action, setAction] = useState<'submit' | 'resend' | null>(null)
  const checklist = usePasswordChecklist(password, { email })
  const limits = useRetryAfter<'submit' | 'resend'>(reset.error)
  const placed = placeErrors(reset.error, fieldResolver(['code', 'password']))
  const wait = limits.secondsLeft('submit')

  const submit = async () => {
    setResent(false)
    const problems = {
      ...(code.length !== CODE_LENGTH && { code: t.verification.codeIncomplete }),
      ...(password === '' && { password: t.common.required }),
    }
    if (Object.keys(problems).length > 0) {
      setLocal(problems)
      return
    }
    setLocal(null)
    limits.mark('submit')
    setAction('submit')
    const next = await reset.submit({ code, password })
    if (next?.status === 'complete') {
      setPassword('')
    }
  }
  const resend = async () => {
    setLocal(null)
    setResent(false)
    limits.mark('resend')
    setAction('resend')
    setResent((await reset.resendCode()) !== null)
  }

  return (
    <Card
      title={t.resetPassword.newPasswordTitle}
      subtitle={formatText(t.resetPassword.newPasswordSubtitle, { destination: props.destination })}
      focusTitle={props.focusTitle}
      footer={
        <Button kind='link' onClick={props.onBack}>
          {t.resetPassword.backToSignIn}
        </Button>
      }
    >
      <Form onSubmit={submit} failure={local ?? reset.error} blocked={reset.isPending || wait > 0}>
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        <input
          className='tula-visually-hidden'
          type='text'
          name='username'
          autoComplete='username'
          value={email}
          readOnly
          tabIndex={-1}
          aria-hidden='true'
        />
        <CodeField
          value={code}
          onValue={(value) => {
            setCode(value)
            setLocal(null)
          }}
          errors={local?.code ? [local.code] : local ? [] : placed.fields.code}
        />
        <PasswordField
          label={t.resetPassword.newPasswordLabel}
          name='new-password'
          autoComplete='new-password'
          value={password}
          onValue={(value) => {
            setPassword(value)
            setLocal(null)
          }}
          errors={local?.password ? [local.password] : local ? [] : placed.fields.password}
          checks={checklist.checks}
          required
        />
        <Button
          type='submit'
          pending={reset.isPending && action === 'submit'}
          disabled={reset.isPending || wait > 0}
        >
          {t.resetPassword.submit}
        </Button>
        <div className='tula-actions'>
          <ResendButton
            secondsLeft={limits.secondsLeft('resend')}
            pending={reset.isPending && action === 'resend'}
            onResend={resend}
          />
        </div>
        <Status message={resent ? t.verification.resent : null} />
      </Form>
    </Card>
  )
}

function SignInScreens(props: SignInProps) {
  const { t } = useUi()
  const { navigation } = useTulaContext()
  const signInFlow = useSignIn()
  const resetFlow = useResetPassword()
  const [view, setView] = useState<'sign-in' | 'reset-password'>('sign-in')
  const [email, setEmail] = useState(props.initialEmail ?? '')

  const active = view === 'sign-in' ? signInFlow : resetFlow
  const step: FlowStep | null = active.step
  const screen = `${view}:${step?.status ?? 'start'}`
  const focusTitle = useScreenChanged(screen)
  const { signedIn, finish } = useCompletion(active, {
    onComplete: props.onComplete,
    url: props.afterSignInUrl ?? navigation.afterSignInUrl,
  })
  // Every action that can complete the flow reports its result to `finish`.
  const signIn: UseSignInResult = {
    ...signInFlow,
    start: (input) => signInFlow.start(input).then(finish),
    submitPassword: (input) => signInFlow.submitPassword(input).then(finish),
    verifyEmail: (input) => signInFlow.verifyEmail(input).then(finish),
  }
  const reset: UseResetPasswordResult = {
    ...resetFlow,
    submit: (input) => resetFlow.submit(input).then(finish),
  }

  const toSignIn = () => {
    reset.reset()
    signIn.reset()
    setView('sign-in')
  }
  const toReset = () => {
    signIn.reset()
    reset.reset()
    setView('reset-password')
  }

  if (signedIn) {
    return <SignedInNotice key={screen} focusTitle={focusTitle} />
  }
  const unsupported = (
    <UnsupportedScreen key={screen} focusTitle={focusTitle} onRestart={toSignIn} />
  )

  if (view === 'reset-password') {
    switch (step?.status) {
      case undefined:
        return (
          <ResetStartScreen
            key={screen}
            email={email}
            setEmail={setEmail}
            reset={reset}
            focusTitle={focusTitle}
            onBack={toSignIn}
          />
        )
      case 'needs_new_password':
        return (
          <NewPasswordScreen
            key={screen}
            email={email}
            destination={step.destination}
            reset={reset}
            focusTitle={focusTitle}
            onBack={toSignIn}
          />
        )
      default:
        // `needs_second_factor` after a reset, or a step a newer server added.
        return unsupported
    }
  }

  const factor = { email, signIn, focusTitle, onForgotPassword: toReset, onChangeEmail: toSignIn }
  switch (step?.status) {
    case undefined:
    case 'needs_identifier':
      return (
        <IdentifierScreen
          key={screen}
          email={email}
          setEmail={setEmail}
          signIn={signIn}
          focusTitle={focusTitle}
          footer={
            <SwitchLink
              prompt={t.signIn.noAccount}
              label={t.signIn.signUpLink}
              url={props.signUpUrl ?? navigation.signUpUrl}
              onSwitch={props.onSwitchToSignUp}
            />
          }
        />
      )
    case 'needs_password':
      return <PasswordScreen key={screen} {...factor} />
    case 'needs_first_factor':
      return (
        <FirstFactorScreen
          key={screen}
          {...factor}
          strategies={step.strategies}
          onRestart={toSignIn}
        />
      )
    case 'needs_email_verification':
      return (
        <VerificationScreen
          key={screen}
          destination={step.destination}
          focusTitle={focusTitle}
          isPending={signIn.isPending}
          error={signIn.error}
          verify={(code) => signIn.verifyEmail({ code })}
          resend={signIn.resendCode}
        />
      )
    default:
      // `needs_second_factor` (its screens arrive with TOTP), or a step a newer server added.
      return unsupported
  }
}

/**
 * A complete sign-in: email, then whatever the server asks for next (a password, an emailed
 * code), with "Forgot password?" leading into the reset flow in the same card.
 *
 * The component holds no flow logic: each screen is the server's current step. A step this
 * version does not know (a method added to the server later) shows a clear "not supported"
 * state instead of a blank card.
 *
 * @param props - URLs, callbacks and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <SignedOut>
 *   <SignIn signUpUrl='/sign-up' afterSignInUrl='/app' />
 * </SignedOut>
 * ```
 */
export function SignIn(props: SignInProps) {
  return (
    <Root appearance={props.appearance} headingLevel={props.headingLevel}>
      <SignInScreens {...props} />
    </Root>
  )
}
