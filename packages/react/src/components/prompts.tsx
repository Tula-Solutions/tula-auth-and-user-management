import type { StepUpMethod, StepUpProof, TulaError } from '@tula/core'
import { type ReactNode, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useAuthState } from '../hooks/use-auth-state'
import { formatText } from '../localization'
import { useRetryAfter } from './flow-screens'
import { formatDuration } from './form-errors'
import { BackupCodesPanel, drawableFactors, SecondFactorForm } from './mfa'
import { Button, Form, FormError, Heading, PasswordField, Root, useUi } from './ui'

/**
 * What the provider is asking the user, above whatever the app is showing: to prove who they
 * are before a sensitive change, or to save backup codes that are shown once.
 */
export type Prompt =
  | {
      kind: 'step-up'
      /** What the user can step up with; empty when they can only sign in again. */
      methods: readonly StepUpMethod[]
      /** Called once: `true` when the session was stepped up, `false` when the user gave up. */
      resolve(proven: boolean): void
    }
  | {
      kind: 'backup-codes'
      codes: readonly string[]
      /** Called once the user says they saved the codes. */
      resolve(): void
    }

/**
 * A modal dialog (`<dialog>` opened with `showModal`, so focus is trapped, the page behind is
 * inert and Escape is announced by the browser). Its title labels it.
 */
function Modal(props: { title: string; onCancel?(): void; children: ReactNode }) {
  const { el } = useUi()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const element = dialog.current
    // What had the focus when the dialog opened gets it back when it closes. The browser does
    // this for a dialog that is closed; this one is taken out of the page instead.
    const opener = document.activeElement
    if (element && typeof element.showModal === 'function' && !element.open) {
      element.showModal()
    }
    // Open on the field the dialog is for; a dialog with nothing to type opens on its title,
    // so that a screen reader starts from what it says.
    const field = element?.querySelector<HTMLElement>('input:not([type="checkbox"])')
    ;(field ?? title.current)?.focus()
    return () => {
      if (element?.open) {
        element.close()
      }
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus()
      }
    }
  }, [])
  const { onCancel } = props
  // Escape asks to cancel; the prompt decides. Backup codes cannot be dismissed unsaved.
  const cancel = (event: SyntheticEvent) => {
    event.preventDefault()
    onCancel?.()
  }
  return (
    <dialog {...el('modal')} ref={dialog} aria-labelledby={titleId} onCancel={cancel}>
      <section {...el('card')}>
        <header {...el('header')}>
          <Heading {...el('title')} id={titleId} headingRef={title}>
            {props.title}
          </Heading>
        </header>
        {props.children}
      </section>
    </dialog>
  )
}

/** The password form of a step-up, for a user without a second factor. */
function PasswordStepUp(props: {
  isPending: boolean
  error: TulaError | null
  submit(proof: StepUpProof): Promise<boolean>
}) {
  const { t } = useUi()
  const { error, isPending } = props
  const [password, setPassword] = useState('')
  const [missing, setMissing] = useState(false)
  const limits = useRetryAfter<'verify'>(error, 'verify')
  const wait = limits.secondsLeft('verify')
  const wrong = error?.code === 'auth.invalid_credentials'
  const submit = async () => {
    if (password === '') {
      setMissing(true)
      return
    }
    limits.mark('verify')
    if (!(await props.submit({ method: 'password', password }))) {
      // A wrong password is retyped from scratch, as at sign-in.
      setPassword('')
    }
  }
  return (
    <Form onSubmit={submit} failure={missing || error} blocked={isPending || wait > 0}>
      <p className='tula-text'>{t.stepUp.passwordSubtitle}</p>
      <FormError
        message={error && !wrong ? error.message : null}
        detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
      />
      <PasswordField
        label={t.stepUp.passwordLabel}
        name='current-password'
        autoComplete='current-password'
        value={password}
        onValue={(value) => {
          setPassword(value)
          setMissing(false)
        }}
        errors={missing ? [t.common.required] : wrong ? [t.stepUp.passwordWrong] : []}
        required
      />
      <Button type='submit' pending={isPending} disabled={wait > 0}>
        {t.stepUp.submit}
      </Button>
    </Form>
  )
}

/**
 * The step-up dialog: asks for the factor the server said this user can step up with, sends
 * it (`client.session.stepUp`) and reports whether the session was stepped up. What is typed
 * lives in the dialog's state and goes when it closes.
 */
function StepUpDialog(props: { methods: readonly StepUpMethod[]; onDone(proven: boolean): void }) {
  const { t } = useUi()
  const { client } = useTulaContext()
  const state = useAuthState(client)
  const { methods, onDone } = props
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const second = drawableFactors(methods)
  const signedIn = state.status === 'signed-in'

  useEffect(() => {
    // Signed out underneath the dialog (another tab, a revoked session): nothing to prove.
    if (!signedIn) {
      onDone(false)
    }
  }, [signedIn, onDone])

  const submit = async (proof: StepUpProof): Promise<boolean> => {
    setPending(true)
    setError(null)
    try {
      await client.session.stepUp(proof)
    } catch (caught) {
      setError(toTulaError(caught))
      setPending(false)
      return false
    }
    onDone(true)
    return true
  }
  const cancel = () => onDone(false)
  return (
    <Modal title={t.stepUp.title} onCancel={cancel}>
      {second.length > 0 ? (
        <SecondFactorForm
          methods={second}
          isPending={isPending}
          error={error}
          submitLabel={t.stepUp.submit}
          totpSubtitle={t.stepUp.totpSubtitle}
          backupSubtitle={t.stepUp.backupSubtitle}
          submit={submit}
        />
      ) : methods.includes('password') ? (
        <PasswordStepUp isPending={isPending} error={error} submit={submit} />
      ) : (
        <p className='tula-text'>{t.stepUp.noMethod}</p>
      )}
      <Button kind='secondary' onClick={cancel}>
        {second.length > 0 || methods.includes('password') ? t.stepUp.cancel : t.stepUp.close}
      </Button>
    </Modal>
  )
}

/**
 * Draws the provider's current prompt, in a modal dialog above the app. It lives in the
 * provider, not in the component that asked: a sign-in that enrolled an authenticator signs
 * the user in, an app usually unmounts its sign-in page at that moment, and the backup codes
 * must still be shown.
 */
export function PromptHost(props: { prompt: Prompt | null; onClose(): void }) {
  const { prompt, onClose } = props
  if (prompt === null) {
    return null
  }
  return (
    <Root appearance={undefined}>
      {prompt.kind === 'step-up' ? (
        <StepUpDialog
          methods={prompt.methods}
          onDone={(proven) => {
            onClose()
            prompt.resolve(proven)
          }}
        />
      ) : (
        <BackupCodesDialog
          codes={prompt.codes}
          onDone={() => {
            onClose()
            prompt.resolve()
          }}
        />
      )}
    </Root>
  )
}

function BackupCodesDialog(props: { codes: readonly string[]; onDone(): void }) {
  const { t } = useUi()
  return (
    <Modal title={t.mfa.backupCodesTitle}>
      <BackupCodesPanel codes={props.codes} onDone={props.onDone} />
    </Modal>
  )
}
