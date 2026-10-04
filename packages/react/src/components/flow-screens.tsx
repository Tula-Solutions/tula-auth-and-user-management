import type { FactorEnrolmentResult, FlowStep, TulaError } from '@tula/core'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { useAuthState } from '../hooks/use-auth-state'
import { useCountdown } from '../hooks/use-countdown'
import type { FactorEnrolmentHookActions } from '../hooks/use-flow'
import { formatText } from '../localization'
import { go } from '../navigation'
import { attemptsLeft, fieldResolver, formatDuration, placeErrors } from './form-errors'
import { Button, Card, Form, FormError, Status, TextField, useUi } from './ui'

/** What a completed flow hands to `onComplete`. */
export interface FlowResult {
  /** The signed-in user's id. */
  userId: string
  /** The new session's id. */
  sessionId: string
}

/**
 * How long each of a screen's actions is refused for, from the `retryAfterMs` of the errors
 * the server answered them with: the lockout after repeated wrong passwords, the one-a-minute
 * limit on emails. The component only counts down what the server said; it decides nothing.
 *
 * @param error - The flow's current error.
 * @param arrivedWith - The action a limit belongs to when the screen appears with the error
 *   already there (the previous screen ran that action on this one's behalf).
 * @returns `mark(action)` to call before running an action, and the seconds left per action.
 */
export function useRetryAfter<Action extends string>(
  error: TulaError | null,
  arrivedWith: Action | null = null
): { mark(action: Action): void; secondsLeft(action: Action): number } {
  const last = useRef<Action | null>(arrivedWith)
  const [limits, setLimits] = useState<{ action: Action; until: number }[]>([])
  useEffect(() => {
    const action = last.current
    if (error?.retryAfterMs === undefined || action === null) {
      return
    }
    const until = Date.now() + error.retryAfterMs
    setLimits((current) => [
      ...current.filter((limit) => limit.action !== action),
      { action, until },
    ])
  }, [error])
  // One ticking clock re-renders the screen each second while any limit is running; each
  // limit is then read against the time of that render.
  const latest = limits.reduce<number | null>((max, limit) => Math.max(max ?? 0, limit.until), null)
  useCountdown(latest)
  return {
    mark(action) {
      last.current = action
    },
    secondsLeft(action) {
      const limit = limits.find((entry) => entry.action === action)
      return limit ? Math.max(0, Math.ceil((limit.until - Date.now()) / 1000)) : 0
    },
  }
}

/**
 * Tell the app a flow has completed, once: call `onComplete`, or go to `url`.
 *
 * `finish` is called with the step an action resolved with, not from an effect: an app that
 * wraps the component in `<SignedOut>` unmounts it the moment the client is signed in, which
 * is before React would run an effect for the completed step.
 *
 * A user who is already signed in when the component mounts (and has started nothing) is sent
 * to `url` as well.
 *
 * @param flow - The flow's current step and whether an action is pending.
 * @param options - The callback and the URL.
 * @returns `signedIn`: draw the "signed in" notice instead of a form. `finish`: pass every
 *   action's result through it.
 */
export function useCompletion(
  flow: { step: FlowStep | null; isPending: boolean },
  options: { onComplete?: (result: FlowResult) => void; url: string | undefined }
): { signedIn: boolean; finish(next: FlowStep | null): FlowStep | null } {
  const { client, navigation } = useTulaContext()
  const state = useAuthState(client)
  const done = useRef(false)
  const latest = useRef({ ...options, navigate: navigation.navigate })
  latest.current = { ...options, navigate: navigation.navigate }
  const { step, isPending } = flow
  const alreadySignedIn = state.status === 'signed-in' && step === null && !isPending

  const finish = useCallback((next: FlowStep | null) => {
    if (next?.status === 'complete' && !done.current) {
      done.current = true
      const { onComplete, url, navigate } = latest.current
      if (onComplete) {
        onComplete({ userId: next.userId, sessionId: next.sessionId })
      } else {
        go(url, navigate)
      }
    }
    return next
  }, [])

  useEffect(() => {
    if (!alreadySignedIn || done.current) {
      return
    }
    // One turn later, not now. A sign-in that is an attempt of its own (a passkey) signs the
    // client in a moment before its flow is handed to `finish`: that completion, with the
    // app's `onComplete`, must not lose to this "was already signed in".
    const timer = setTimeout(() => {
      if (!done.current) {
        done.current = true
        go(latest.current.url, latest.current.navigate)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [alreadySignedIn])

  return { signedIn: step?.status === 'complete' || alreadySignedIn, finish }
}

/**
 * Complete a flow that ends by enrolling an authenticator: confirm, show the backup codes, and
 * only then tell the app the flow has completed.
 *
 * Confirming signs the client in, and an app usually takes its sign-in page away at that
 * moment. So the codes are shown by the provider's dialog, which outlives the page, and
 * `finish` (the app's `onComplete`, or the navigation) waits for the user to say they saved
 * them.
 *
 * @param flow - The flow hook's enrolment action.
 * @param finish - From {@link useCompletion}.
 * @returns The `confirm` an enrolment screen calls.
 */
export function useEnrolmentCompletion(
  flow: Pick<FactorEnrolmentHookActions, 'confirmTotpEnrolment'>,
  finish: (next: FlowStep | null) => FlowStep | null
): (code: string) => Promise<FactorEnrolmentResult | null> {
  const { prompts } = useTulaContext()
  const { confirmTotpEnrolment } = flow
  return useCallback(
    async (code) => {
      const result = await confirmTotpEnrolment({ code })
      if (result) {
        await prompts.backupCodes(result.backupCodes)
        finish(result.step)
      }
      return result
    },
    [confirmTotpEnrolment, prompts, finish]
  )
}

/** Shown in place of a form once the user is signed in (while the app navigates away). */
export function SignedInNotice(props: { focusTitle: boolean }) {
  const { t } = useUi()
  return (
    <Card title={t.signIn.signedIn} focusTitle={props.focusTitle}>
      {null}
    </Card>
  )
}

/**
 * A step this version cannot draw: a second factor it does not know (a passkey, until its
 * screen ships), a first-factor list with nothing this version implements, or a status a
 * newer server invented. It says so
 * and offers to start again; it never renders a blank card and never guesses at an action.
 */
export function UnsupportedScreen(props: { focusTitle: boolean; onRestart(): void }) {
  const { t } = useUi()
  return (
    <Card title={t.unsupported.title} focusTitle={props.focusTitle}>
      <p className='tula-text' data-tula-unsupported=''>
        {t.unsupported.message}
      </p>
      <Button kind='secondary' onClick={props.onRestart}>
        {t.unsupported.restart}
      </Button>
    </Card>
  )
}

/** Keep the digits of whatever was typed or pasted ("123 456", "123-456"), at most six. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH)
}

/** Length of an emailed code. */
export const CODE_LENGTH = 6

/**
 * The field for an emailed code: one input, so that the browser's one-time-code autofill and
 * a paste of the whole code both work, with a numeric keypad on phones.
 */
export function CodeField(props: {
  value: string
  onValue(value: string): void
  errors?: string[]
}) {
  const { t } = useUi()
  return (
    <TextField
      part='codeInput'
      label={t.verification.codeLabel}
      hint={t.verification.codeHint}
      name='code'
      type='text'
      inputMode='numeric'
      autoComplete='one-time-code'
      pattern='[0-9]*'
      maxLength={CODE_LENGTH + 4}
      value={props.value}
      onValue={(value) => props.onValue(digitsOnly(value))}
      errors={props.errors}
      required
    />
  )
}

/**
 * The "Resend code" button with the server's cooldown counted down on it. `label` and
 * `waitingLabel` (with `{time}`) replace its words where what is resent is not a code alone.
 */
export function ResendButton(props: {
  secondsLeft: number
  pending: boolean
  onResend(): void
  label?: string
  waitingLabel?: string
}) {
  const { t } = useUi()
  const waiting = props.secondsLeft > 0
  return (
    <Button kind='link' pending={props.pending} disabled={waiting} onClick={props.onResend}>
      {waiting
        ? formatText(props.waitingLabel ?? t.verification.resendIn, {
            time: formatDuration(props.secondsLeft, t),
          })
        : (props.label ?? t.verification.resend)}
    </Button>
  )
}

/** The address a sign-in is for, with a way back to change it. */
export function IdentityRow(props: { email: string; onChange(): void }) {
  const { el, t } = useUi()
  return (
    <p {...el('identity')}>
      <span>{props.email}</span>
      <Button kind='link' onClick={props.onChange}>
        {t.signIn.changeEmail}
      </Button>
    </p>
  )
}

/**
 * The emailed-code screen (`needs_email_verification`) of sign-up and sign-in.
 */
export function VerificationScreen(props: {
  destination: string
  focusTitle: boolean
  isPending: boolean
  error: TulaError | null
  verify(code: string): Promise<FlowStep | null>
  resend(): Promise<FlowStep | null>
  footer?: ReactNode
}) {
  const { t } = useUi()
  const { error, isPending } = props
  const [code, setCode] = useState('')
  const [incomplete, setIncomplete] = useState<{ message: string } | null>(null)
  const [resent, setResent] = useState(false)
  const [action, setAction] = useState<'verify' | 'resend' | null>(null)
  const limits = useRetryAfter<'verify' | 'resend'>(error)

  const placed = placeErrors(error, fieldResolver(['code']))
  const hint = attemptsLeft(error, t)
  const codeErrors = incomplete
    ? [incomplete.message]
    : (placed.fields.code ?? []).map((message) => (hint ? `${message} ${hint}` : message))
  const verifyWait = limits.secondsLeft('verify')

  const submit = async () => {
    setResent(false)
    if (code.length !== CODE_LENGTH) {
      setIncomplete({ message: t.verification.codeIncomplete })
      return
    }
    setIncomplete(null)
    limits.mark('verify')
    setAction('verify')
    const next = await props.verify(code)
    if (next === null) {
      // A wrong code is retyped from scratch.
      setCode('')
    }
  }
  const resend = async () => {
    setIncomplete(null)
    setResent(false)
    limits.mark('resend')
    setAction('resend')
    const next = await props.resend()
    setResent(next !== null)
  }

  return (
    <Card
      title={t.verification.title}
      subtitle={formatText(t.verification.subtitle, { destination: props.destination })}
      focusTitle={props.focusTitle}
      footer={props.footer}
    >
      <Form onSubmit={submit} failure={incomplete ?? error} blocked={isPending || verifyWait > 0}>
        <FormError
          message={placed.form}
          detail={
            verifyWait > 0
              ? formatText(t.common.retryIn, { time: formatDuration(verifyWait, t) })
              : null
          }
        />
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
          pending={isPending && action === 'verify'}
          disabled={isPending || verifyWait > 0}
        >
          {t.verification.submit}
        </Button>
        <div className='tula-actions'>
          <ResendButton
            secondsLeft={limits.secondsLeft('resend')}
            pending={isPending && action === 'resend'}
            onResend={resend}
          />
        </div>
        <Status message={resent ? t.verification.resent : null} />
      </Form>
    </Card>
  )
}
