import type { FirstFactorStrategy, FlowStep } from '@tula/core'
import {
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
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
  IdentityRow,
  ResendButton,
  SignedInNotice,
  UnsupportedScreen,
  useCompletion,
  useEnrolmentCompletion,
  useRetryAfter,
  VerificationScreen,
} from './flow-screens'
import { attemptsLeft, fieldResolver, formatDuration, placeErrors } from './form-errors'
import { canEnrolTotp, drawableFactors, FactorEnrolmentScreen, SecondFactorScreen } from './mfa'
import { OAuthButtons } from './oauth'
import { PasskeySignIn, usePasskeyOffered, usePasskeySupport } from './passkey'
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
  /**
   * The page emailed sign-in links lead to: the one that renders `<EmailLinkCallback>`. It
   * must be one of the environment's allowed redirect URLs, exactly. Overrides the provider's
   * `emailLinkUrl`; without either, "Email me a link" is not offered.
   */
  emailLinkUrl?: string
  /**
   * The page an OAuth sign-in returns to: the one that renders `<OAuthCallback>`. It must be
   * one of the environment's allowed redirect URLs, exactly. Overrides the provider's
   * `oauthCallbackUrl`; without either, no "Continue with …" button is drawn.
   */
  oauthCallbackUrl?: string
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

/** The `needs_first_factor` step. */
type FirstFactorStep = Extract<FlowStep, { status: 'needs_first_factor' }>

/** What a first-factor form gets. */
interface FirstFactorProps {
  email: string
  signIn: UseSignInResult
  focusTitle: boolean
  onForgotPassword(): void
  onChangeEmail(): void
  /** What the server last emailed for this attempt, when it has. */
  prepared?: FirstFactorStep['prepared']
  /** Ask the server for the email of an email strategy (again, for a fresh one). */
  sendEmail?(strategy: 'email_code' | 'email_link'): Promise<FlowStep | null>
  /** The other ways to sign in the attempt offers, drawn under the form. */
  alternatives?: ReactNode
}

/**
 * The first factors this version can draw, by strategy. A later step adds a method by adding
 * its form here; a strategy with no entry is skipped (the OAuth ones are buttons on the first
 * screen, not forms).
 */
const FIRST_FACTOR_FORMS: Partial<Record<FirstFactorStrategy, ComponentType<FirstFactorProps>>> = {
  password: PasswordScreen,
  email_code: EmailCodeScreen,
  email_link: EmailLinkScreen,
  passkey: PasskeyScreen,
}

function supportedStrategies(
  strategies: readonly string[],
  can: { link: boolean; passkey: boolean }
): FirstFactorStrategy[] {
  return strategies.filter(
    (strategy): strategy is FirstFactorStrategy =>
      Object.hasOwn(FIRST_FACTOR_FORMS, strategy) &&
      (strategy !== 'email_link' || can.link) &&
      // Hidden, not broken, in a browser without WebAuthn.
      (strategy !== 'passkey' || can.passkey)
  )
}

/**
 * The absolute URL an emailed link should lead to, from the developer's prop. Only ever called
 * from an event handler, never during render.
 */
function resolveLinkUrl(url: string | undefined): string | null {
  return typeof window === 'undefined' ? null : safeUrl(url, window.location.href)
}

function IdentifierScreen(props: {
  email: string
  setEmail(value: string): void
  signIn: UseSignInResult
  focusTitle: boolean
  footer: ReactNode
  oauthCallbackUrl: string | undefined
  /** From `useCompletion`: taken by a passkey sign-in for as long as it is in flight. */
  holdCompletion(): () => void
}) {
  const { t } = useUi()
  const { signIn, email } = props
  const appName = useClientConfig()?.app.name
  const passkeys = usePasskeyOffered()
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
      <OAuthButtons callbackUrl={props.oauthCallbackUrl} />
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
          // `webauthn` lets the browser offer the user's passkeys in this field's autofill.
          autoComplete={passkeys ? 'username webauthn' : 'username'}
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
      {/* After the form in the document: Tab goes from the address to "Continue" first. */}
      <PasskeySignIn
        autofill
        onFlow={signIn.adopt}
        hold={props.holdCompletion}
        disabled={signIn.isPending}
      />
    </Card>
  )
}

function PasswordScreen(props: FirstFactorProps) {
  const { t } = useUi()
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
      <IdentityRow email={email} onChange={props.onChangeEmail} />
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
      {props.alternatives}
    </Card>
  )
}

/**
 * The emailed first factors: a code, or a link (whose email carries the code as well).
 *
 * Before the server has emailed anything it offers to; afterwards it takes the code, and for a
 * link also waits for the link to be opened in this browser. The waiting is the flow's (the
 * hook's `waitForEmailLink`): this screen starts it when it appears and stops it when it goes.
 */
function EmailFactorScreen(props: FirstFactorProps & { strategy: 'email_code' | 'email_link' }) {
  const { el, t } = useUi()
  const { signIn, strategy, prepared } = props
  const [code, setCode] = useState('')
  const [incomplete, setIncomplete] = useState<{ message: string } | null>(null)
  const [resent, setResent] = useState(false)
  const [action, setAction] = useState<'submit' | 'send' | null>(null)
  // When the address screen asked for the email itself and was told to wait, this screen
  // appears with that refusal: it is about sending.
  const limits = useRetryAfter<'submit' | 'send'>(signIn.error, 'send')
  const placed = placeErrors(signIn.error, fieldResolver(['code']))
  const hint = attemptsLeft(signIn.error, t)
  const codeErrors = incomplete
    ? [incomplete.message]
    : (placed.fields.code ?? []).map((message) => (hint ? `${message} ${hint}` : message))
  const submitWait = limits.secondsLeft('submit')
  const sendWait = limits.secondsLeft('send')
  const viaLink = strategy === 'email_link'
  // The email for a link carries the code too, so a link's email serves the code screen.
  const sent = prepared !== undefined && (viaLink ? prepared.strategy === 'email_link' : true)
  const waiting = viaLink && sent

  // The latest `waitForEmailLink`, read by the effect below without making it re-run: its
  // identity changes with every render of the parent.
  const wait = useRef(signIn.waitForEmailLink)
  wait.current = signIn.waitForEmailLink
  useEffect(() => {
    if (!waiting) {
      return
    }
    const leaving = new AbortController()
    void wait.current({ signal: leaving.signal })
    return () => leaving.abort()
  }, [waiting])

  const send = async (again: boolean) => {
    setIncomplete(null)
    setResent(false)
    limits.mark('send')
    setAction('send')
    const next = (await props.sendEmail?.(strategy)) ?? null
    setResent(again && next !== null)
  }
  const submit = async () => {
    setResent(false)
    if (code.length !== CODE_LENGTH) {
      setIncomplete({ message: t.verification.codeIncomplete })
      return
    }
    setIncomplete(null)
    limits.mark('submit')
    setAction('submit')
    const next = await signIn.attemptFirstFactor({ strategy: 'email_code', code })
    if (next === null) {
      // A wrong code is retyped from scratch.
      setCode('')
    }
  }
  const retry = (seconds: number) =>
    seconds > 0 ? formatText(t.common.retryIn, { time: formatDuration(seconds, t) }) : null

  if (!sent) {
    return (
      <Card
        key='ask'
        title={viaLink ? t.signIn.emailLink : t.signIn.emailCode}
        subtitle={viaLink ? t.signIn.emailLinkPrompt : t.signIn.emailCodePrompt}
        focusTitle={props.focusTitle}
      >
        <IdentityRow email={props.email} onChange={props.onChangeEmail} />
        <Form
          onSubmit={() => void send(false)}
          failure={signIn.error}
          blocked={signIn.isPending || sendWait > 0}
        >
          <FormError message={placed.form} detail={retry(sendWait)} />
          <Button type='submit' pending={signIn.isPending} disabled={sendWait > 0}>
            {viaLink ? t.signIn.emailLink : t.signIn.emailCode}
          </Button>
        </Form>
        {props.alternatives}
      </Card>
    )
  }

  return (
    // A different card from the one that asked: its title takes focus, so the change from
    // "about to send" to "sent" is announced.
    <Card
      key='sent'
      title={t.signIn.emailTitle}
      subtitle={formatText(viaLink ? t.signIn.emailLinkSubtitle : t.signIn.emailCodeSubtitle, {
        destination: prepared.destination,
      })}
      focusTitle={props.focusTitle}
    >
      <IdentityRow email={props.email} onChange={props.onChangeEmail} />
      {waiting ? (
        <>
          {/* Not a live region: it is there when the screen appears and never changes. */}
          <p {...el('waiting')}>
            <span {...el('spinner')} aria-hidden='true' />
            <span>{t.signIn.emailLinkWaiting}</span>
          </p>
          <p className='tula-text'>{t.signIn.emailLinkCodeHint}</p>
        </>
      ) : null}
      <Form
        onSubmit={submit}
        failure={incomplete ?? signIn.error}
        blocked={signIn.isPending || submitWait > 0}
      >
        <FormError message={placed.form} detail={retry(Math.max(submitWait, sendWait))} />
        <CodeField
          value={code}
          onValue={(value) => {
            setCode(value)
            setIncomplete(null)
          }}
          errors={codeErrors}
        />
        <Button
          type='submit'
          pending={signIn.isPending && action === 'submit'}
          disabled={signIn.isPending || submitWait > 0}
        >
          {t.signIn.emailCodeSubmit}
        </Button>
        <div className='tula-actions'>
          <ResendButton
            secondsLeft={sendWait}
            pending={signIn.isPending && action === 'send'}
            onResend={() => void send(true)}
            label={t.signIn.emailResend}
            waitingLabel={t.signIn.emailResendIn}
          />
        </div>
        <Status message={resent ? t.signIn.emailResent : null} />
      </Form>
      {props.alternatives}
    </Card>
  )
}

/**
 * The `passkey` first factor, chosen after an address was given. A passkey names its own
 * account, so this is a sign-in of its own that takes the place of the attempt on screen.
 */
function PasskeyScreen(props: FirstFactorProps) {
  const { t } = useUi()
  return (
    <Card title={t.passkey.signIn} subtitle={t.passkey.signInPrompt} focusTitle={props.focusTitle}>
      <IdentityRow email={props.email} onChange={props.onChangeEmail} />
      <PasskeySignIn offered onFlow={props.signIn.adopt} disabled={props.signIn.isPending} />
      {props.alternatives}
    </Card>
  )
}

function EmailCodeScreen(props: FirstFactorProps) {
  return <EmailFactorScreen {...props} strategy='email_code' />
}

function EmailLinkScreen(props: FirstFactorProps) {
  return <EmailFactorScreen {...props} strategy='email_link' />
}

/** The label of the button that switches to a strategy. */
function strategyLabel(
  strategy: FirstFactorStrategy,
  t: ReturnType<typeof useUi>['t']
): string | null {
  switch (strategy) {
    case 'password':
      return t.signIn.usePassword
    case 'email_code':
      return t.signIn.emailCode
    case 'email_link':
      return t.signIn.emailLink
    case 'passkey':
      return t.passkey.signIn
    default:
      return null
  }
}

/** `needs_first_factor`: one form per strategy the server offered that this version knows. */
function FirstFactorScreen(
  props: Omit<FirstFactorProps, 'prepared' | 'alternatives' | 'sendEmail'> & {
    step: FirstFactorStep
    /** The page an emailed link leads to, as the developer gave it. */
    emailLinkUrl?: string
    onRestart(): void
  }
) {
  const { el, t } = useUi()
  const { step, onRestart, emailLinkUrl: _emailLinkUrl, ...form } = props
  const { signIn } = props
  const { prepared } = step
  // Whether a link could be honoured here is a fact about the browser (storage) and about the
  // developer's prop, read after mount: nothing during render touches storage.
  const [storageUsable, setStorageUsable] = useState(false)
  const canUse = useRef(signIn.canUseEmailLink)
  canUse.current = signIn.canUseEmailLink
  useEffect(() => {
    setStorageUsable(canUse.current())
  }, [])
  const linkConfigured = safeUrl(props.emailLinkUrl, 'http://localhost') !== null
  // Until the browser has been asked (after mount) a passkey is not ruled out: where it is the
  // only method, the screen must not open on "not supported" and then change its mind.
  const passkeySupport = usePasskeySupport()
  const known = supportedStrategies(step.strategies, {
    link: storageUsable && linkConfigured,
    passkey: passkeySupport !== false,
  })
  // What the user picked on this screen; until then, what the server last emailed for, or the
  // first strategy on offer.
  const [chosen, setChosen] = useState<FirstFactorStrategy | null>(null)
  /** The email method whose email is being asked for from the list of other ways. */
  const [sending, setSending] = useState<FirstFactorStrategy | null>(null)
  const emailed = prepared && known.includes(prepared.strategy) ? prepared.strategy : undefined
  const active = chosen && known.includes(chosen) ? chosen : (emailed ?? known[0])
  const Screen = active ? FIRST_FACTOR_FORMS[active] : undefined
  if (!Screen || !active) {
    return <UnsupportedScreen focusTitle={props.focusTitle} onRestart={onRestart} />
  }

  const others = known.filter(
    (strategy) =>
      strategy !== active &&
      // Among the other ways only once the browser is known to have WebAuthn, as on the
      // second-factor and step-up screens (`mfa.tsx`, `prompts.tsx`): "not ruled out" above is
      // for the screen itself. The cost, accepted: support is asked after mount, so in a
      // browser that has WebAuthn the link (and, where it is the only other way, this whole
      // list) is drawn one commit after the screen, a frame late and after the title has taken
      // the focus. The other choice draws, in a browser that has none, a link that is then
      // taken away: a control that is broken for as long as it shows. Late is better than
      // wrong. `passkey.test.tsx` pins both halves.
      (strategy !== 'passkey' || passkeySupport === true) &&
      // The email a link came in carries the code, and that screen takes it.
      !(strategy === 'email_code' && active === 'email_link' && prepared?.strategy === 'email_link')
  )
  const sendEmail = (strategy: 'email_code' | 'email_link') => {
    const redirectUrl = strategy === 'email_link' ? resolveLinkUrl(props.emailLinkUrl) : null
    return signIn.prepareFirstFactor(
      strategy === 'email_link' && redirectUrl !== null
        ? { strategy, redirectUrl }
        : { strategy: 'email_code' }
    )
  }
  const choose = async (strategy: FirstFactorStrategy) => {
    signIn.clearError()
    // Choosing an email method is asking for the email: one click, not two. An email that is
    // already there is not sent again (a link's email carries the code as well). If the email
    // cannot be sent (too soon after the last one), the method's screen says so and offers to.
    const needsEmail =
      strategy === 'email_link'
        ? prepared?.strategy !== 'email_link'
        : strategy === 'email_code' && prepared === undefined
    if (needsEmail && (strategy === 'email_code' || strategy === 'email_link')) {
      setSending(strategy)
      await sendEmail(strategy)
      setSending(null)
    }
    setChosen(strategy)
  }
  const alternatives =
    others.length > 0 ? (
      <ul {...el('alternatives')} aria-label={t.signIn.otherMethods}>
        {others.map((strategy) => (
          <li key={strategy}>
            <Button
              kind='link'
              pending={sending === strategy}
              disabled={signIn.isPending}
              onClick={() => void choose(strategy)}
            >
              {strategyLabel(strategy, t)}
            </Button>
          </li>
        ))}
      </ul>
    ) : null
  return (
    <Screen
      key={active}
      {...form}
      prepared={prepared}
      sendEmail={sendEmail}
      alternatives={alternatives}
    />
  )
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
  const { signedIn, finish, hold } = useCompletion(active, {
    onComplete: props.onComplete,
    url: props.afterSignInUrl ?? navigation.afterSignInUrl,
  })
  const emailLinkUrl = props.emailLinkUrl ?? navigation.emailLinkUrl
  // Every action that can complete the flow reports its result to `finish`.
  const signIn: UseSignInResult = {
    ...signInFlow,
    async start(input) {
      const next = await signInFlow.start(input)
      // Where an emailed code is the only way in there is nothing to choose: ask for it, so
      // the user goes from their address straight to the code.
      const only =
        next?.status === 'needs_first_factor' && next.strategies.length === 1
          ? next.strategies[0]
          : undefined
      return finish(
        only === 'email_code'
          ? ((await signInFlow.prepareFirstFactor({ strategy: 'email_code' })) ?? next)
          : next
      )
    },
    submitPassword: (input) => signInFlow.submitPassword(input).then(finish),
    verifyEmail: (input) => signInFlow.verifyEmail(input).then(finish),
    attemptFirstFactor: (input) => signInFlow.attemptFirstFactor(input).then(finish),
    waitForEmailLink: (options) => signInFlow.waitForEmailLink(options).then(finish),
    withPasskey: (request) => signInFlow.withPasskey(request).then(finish),
    adopt(flow) {
      // A passkey sign-in arrives past its first factor, usually complete.
      signInFlow.adopt(flow)
      finish(flow.step)
    },
  }
  const reset: UseResetPasswordResult = {
    ...resetFlow,
    submit: (input) => resetFlow.submit(input).then(finish),
  }
  const confirmEnrolment = useEnrolmentCompletion(active, finish)

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
  // The two steps that can stand between a first factor (or a reset) and the session. The
  // same screens serve a sign-in and a reset.
  const afterFactors = (flow: typeof signInFlow | typeof resetFlow) => {
    if (step?.status === 'needs_second_factor') {
      const methods = drawableFactors(step.options)
      return methods.length === 0 ? null : (
        <SecondFactorScreen
          key={screen}
          methods={methods}
          focusTitle={focusTitle}
          isPending={flow.isPending}
          error={flow.error}
          submit={(proof) => flow.submitSecondFactor(proof).then(finish)}
          submitPasskey={(signal) => flow.submitSecondFactorWithPasskey({ signal }).then(finish)}
          onRestart={toSignIn}
        />
      )
    }
    if (step?.status === 'needs_factor_enrolment' && canEnrolTotp(step.methods)) {
      return (
        <FactorEnrolmentScreen
          key={screen}
          focusTitle={focusTitle}
          isPending={flow.isPending}
          error={flow.error}
          start={flow.startTotpEnrolment}
          confirm={confirmEnrolment}
          onRestart={toSignIn}
        />
      )
    }
    return null
  }

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
        // A step a newer server added.
        return afterFactors(resetFlow) ?? unsupported
    }
  }

  const factor = {
    email,
    signIn,
    focusTitle,
    onForgotPassword: toReset,
    onChangeEmail: toSignIn,
    emailLinkUrl,
  }
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
          oauthCallbackUrl={props.oauthCallbackUrl ?? navigation.oauthCallbackUrl}
          holdCompletion={hold}
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
      return <FirstFactorScreen key={screen} {...factor} step={step} onRestart={toSignIn} />
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
      // A step a newer server added.
      return afterFactors(signInFlow) ?? unsupported
  }
}

/**
 * A complete sign-in: email, then whatever the server asks for next (a password, an emailed
 * code or link, with a way to switch between the ones the environment offers), and "Forgot
 * password?" leading into the reset flow in the same card.
 *
 * Where the environment has passkeys on and the browser can use them, "Sign in with a passkey"
 * is on the first screen (no address needed) and the address field offers the user's passkeys
 * in the browser's autofill.
 *
 * To offer "Email me a link", give `emailLinkUrl` (here or on the provider): the page of your
 * app that renders `<EmailLinkCallback>`, listed in the environment's allowed redirect URLs.
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
