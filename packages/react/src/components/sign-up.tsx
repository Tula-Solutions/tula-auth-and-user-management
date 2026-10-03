import { useState } from 'react'
import type { Appearance } from '../appearance'
import { useTulaContext } from '../context'
import { usePasswordChecklist } from '../hooks/use-password-checklist'
import { type UseSignUpResult, useSignUp } from '../hooks/use-sign-up'
import { formatText } from '../localization'
import {
  type FlowResult,
  SignedInNotice,
  UnsupportedScreen,
  useCompletion,
  useRetryAfter,
  VerificationScreen,
} from './flow-screens'
import { fieldResolver, formatDuration, placeErrors } from './form-errors'
import { SwitchLink } from './sign-in'
import {
  Button,
  Card,
  EmailField,
  Form,
  FormError,
  type HeadingLevel,
  PasswordField,
  Root,
  TextField,
  useScreenChanged,
  useUi,
} from './ui'

/**
 * Props of {@link SignUp}.
 *
 * @example
 * ```tsx
 * <SignUp signInUrl='/sign-in' afterSignUpUrl='/welcome' collectName />
 * ```
 */
export interface SignUpProps {
  /** Where `<SignIn>` lives; shows "Already have an account? Sign in". Overrides the provider's. */
  signInUrl?: string
  /** Called instead of following `signInUrl`, for an app that swaps the two in place. */
  onSwitchToSignIn?: () => void
  /** Where to go once signed up. Overrides the provider's `afterSignUpUrl`. */
  afterSignUpUrl?: string
  /** Called once signed up and signed in, instead of navigating to `afterSignUpUrl`. */
  onComplete?: (result: FlowResult) => void
  /** Also ask for a first and last name (both optional for the user). */
  collectName?: boolean
  /** Theme tokens, colour scheme and class names for this component. */
  appearance?: Appearance
  /** The level of the card's title. Defaults to 1; use 2 when the page has its own `<h1>`. */
  headingLevel?: HeadingLevel
}

const FIELDS = ['firstName', 'lastName', 'email', 'password'] as const

function AccountScreen(props: SignUpProps & { signUp: UseSignUpResult; focusTitle: boolean }) {
  const { t } = useUi()
  const { navigation } = useTulaContext()
  const { signUp, collectName = false } = props
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [local, setLocal] = useState<{ email?: string; password?: string } | null>(null)
  const checklist = usePasswordChecklist(password, { email, firstName, lastName })
  const limits = useRetryAfter<'start'>(signUp.error)
  const placed = placeErrors(signUp.error, fieldResolver(FIELDS))
  const wait = limits.secondsLeft('start')
  const errorsOf = (field: 'email' | 'password') =>
    local?.[field] ? [local[field]] : local ? [] : placed.fields[field]

  const submit = async () => {
    const problems = {
      ...(email.trim() === '' && { email: t.common.required }),
      ...(password === '' && { password: t.common.required }),
    }
    if (Object.keys(problems).length > 0) {
      setLocal(problems)
      return
    }
    setLocal(null)
    limits.mark('start')
    // Whether the password is good enough is the server's call; the checklist above is the
    // same rules, shown live, so the two agree.
    const next = await signUp.start({
      email: email.trim(),
      password,
      ...(collectName && firstName.trim() !== '' && { firstName: firstName.trim() }),
      ...(collectName && lastName.trim() !== '' && { lastName: lastName.trim() }),
    })
    if (next !== null) {
      setPassword('')
    }
  }

  return (
    <Card
      title={t.signUp.title}
      subtitle={t.signUp.subtitle}
      focusTitle={props.focusTitle}
      footer={
        <SwitchLink
          prompt={t.signUp.haveAccount}
          label={t.signUp.signInLink}
          url={props.signInUrl ?? navigation.signInUrl}
          onSwitch={props.onSwitchToSignIn}
        />
      }
    >
      <Form
        onSubmit={submit}
        failure={local ?? signUp.error}
        blocked={signUp.isPending || wait > 0}
      >
        <FormError
          message={placed.form}
          detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
        />
        {collectName ? (
          <div className='tula-field-row'>
            <TextField
              label={t.signUp.firstNameLabel}
              name='firstName'
              autoComplete='given-name'
              value={firstName}
              onValue={setFirstName}
              errors={placed.fields.firstName}
            />
            <TextField
              label={t.signUp.lastNameLabel}
              name='lastName'
              autoComplete='family-name'
              value={lastName}
              onValue={setLastName}
              errors={placed.fields.lastName}
            />
          </div>
        ) : null}
        <EmailField
          label={t.signUp.emailLabel}
          name='email'
          autoComplete='email'
          value={email}
          onValue={(value) => {
            setEmail(value)
            setLocal(null)
          }}
          errors={errorsOf('email')}
          required
        />
        <PasswordField
          label={t.signUp.passwordLabel}
          name='password'
          autoComplete='new-password'
          value={password}
          onValue={(value) => {
            setPassword(value)
            setLocal(null)
          }}
          errors={errorsOf('password')}
          checks={checklist.checks}
          required
        />
        <Button type='submit' pending={signUp.isPending} disabled={wait > 0}>
          {t.signUp.continue}
        </Button>
      </Form>
    </Card>
  )
}

function SignUpScreens(props: SignUpProps) {
  const { navigation } = useTulaContext()
  const flow = useSignUp()
  const { step } = flow
  const screen = step?.status ?? 'start'
  const focusTitle = useScreenChanged(screen)
  const { signedIn, finish } = useCompletion(flow, {
    onComplete: props.onComplete,
    url: props.afterSignUpUrl ?? navigation.afterSignUpUrl,
  })
  const signUp: UseSignUpResult = {
    ...flow,
    start: (input) => flow.start(input).then(finish),
    verifyEmail: (input) => flow.verifyEmail(input).then(finish),
  }

  if (signedIn) {
    return <SignedInNotice key={screen} focusTitle={focusTitle} />
  }
  switch (step?.status) {
    case undefined:
      return <AccountScreen key={screen} {...props} signUp={signUp} focusTitle={focusTitle} />
    case 'needs_email_verification':
      return (
        <VerificationScreen
          key={screen}
          destination={step.destination}
          focusTitle={focusTitle}
          isPending={signUp.isPending}
          error={signUp.error}
          verify={(code) => signUp.verifyEmail({ code })}
          resend={signUp.resendCode}
        />
      )
    default:
      // A step a newer server added to sign-up (choosing a second factor, say).
      return <UnsupportedScreen key={screen} focusTitle={focusTitle} onRestart={signUp.reset} />
  }
}

/**
 * A complete sign-up: email and password with the live password checklist, then the emailed
 * code. The checklist is the environment's own policy evaluated by the same function the
 * server runs; whatever the server still refuses (a breached password, say) is shown on the
 * field it is about.
 *
 * @param props - URLs, callbacks and appearance; all optional.
 * @returns The component.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * <SignedOut>
 *   <SignUp signInUrl='/sign-in' afterSignUpUrl='/welcome' />
 * </SignedOut>
 * ```
 */
export function SignUp(props: SignUpProps) {
  return (
    <Root appearance={props.appearance} headingLevel={props.headingLevel}>
      <SignUpScreens {...props} />
    </Root>
  )
}
