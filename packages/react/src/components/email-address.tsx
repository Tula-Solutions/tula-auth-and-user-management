import { isStepUpRequired, type TulaError, type User } from '@tula/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useStepUp } from '../hooks/use-step-up'
import { formatText } from '../localization'
import { CODE_LENGTH, CodeField, useRetryAfter } from './flow-screens'
import { formatDuration, placeErrors } from './form-errors'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

/** Which screen the section shows: that there is no address, the address form, or the code form. */
type View = 'summary' | 'address' | 'code'

/**
 * "Email address", for an account that has none (ADR 0059): one made by a first sign-in
 * with a provider that gives no address (X, Facebook).
 *
 * Adding is two steps the server decides: an email goes to the address, and the code in it
 * makes the address the account's. The component holds no rule about what an address is,
 * whether it can be added or when a step-up is needed: it sends what was typed, shows the
 * refusal's message at the field it is about, and runs every call through `useStepUp`
 * (a user with nothing to step up with is told by the provider's dialog to sign in again).
 *
 * **The words never say a code was sent.** An address another account holds is answered
 * like a free one and is emailed a notice with no code; the screen says where to look and
 * what the email holds if the address can be added.
 *
 * The typed address and the code are state only while their form is shown. The section is
 * keyed by the session in the profile, and an answer that arrives for a session that is no
 * longer the current one sets nothing. It is drawn only for an account with no address, and
 * stays for as long as it has something to say about the one that was just added.
 */
export function EmailAddressSection(props: { user: User }) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const withStepUp = useStepUp()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>('summary')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [local, setLocal] = useState<{ message: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Where the focus goes once the next screen is drawn; `null` leaves it where it is.
  const [focus, setFocus] = useState<{ on: 'field' | 'title' | 'action' } | null>(null)
  const mounted = useRef(true)
  const limits = useRetryAfter<'send' | 'verify'>(error)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (focus === null) {
      return
    }
    if (focus.on === 'title') {
      title.current?.focus()
    } else {
      body.current?.querySelector<HTMLElement>(focus.on === 'field' ? 'input' : 'button')?.focus()
    }
  }, [focus])

  /** A check that the session a call started under is still the one signed in. */
  const guard = useCallback(() => {
    const sessionOf = () => (client.state.status === 'signed-in' ? client.state.sessionId : null)
    const started = sessionOf()
    return () => mounted.current && started !== null && sessionOf() === started
  }, [client])

  /** Run one action; a step-up the user declined is their choice, not an error to show. */
  const run = async (
    name: NonNullable<typeof busy>,
    work: (stillCurrent: () => boolean) => Promise<void>
  ) => {
    const stillCurrent = guard()
    setBusy(name)
    setError(null)
    setLocal(null)
    setMessage(null)
    try {
      await work(stillCurrent)
    } catch (caught) {
      if (stillCurrent() && !isStepUpRequired(caught)) {
        if (name === 'verify') {
          // A wrong code is typed again from scratch.
          setCode('')
        }
        setError(toTulaError(caught))
      }
    } finally {
      if (stillCurrent()) {
        setBusy(null)
      }
    }
  }
  const show = (next: View, on: 'field' | 'title' | 'action') => {
    setView(next)
    setFocus({ on })
  }
  const close = (on: 'title' | 'action') => {
    setAddress('')
    setCode('')
    setDestination('')
    setError(null)
    setLocal(null)
    show('summary', on)
  }

  const send = () => {
    if (address.trim() === '') {
      setError(null)
      setLocal({ message: t.common.required })
      return
    }
    limits.mark('send')
    void run('send', async (stillCurrent) => {
      const sent = await withStepUp(() => client.user.email.request({ email: address }))
      if (stillCurrent()) {
        // The server's mask of the address; nothing else of it is shown.
        setDestination(sent.destination)
        setCode('')
        show('code', 'field')
      }
    })
  }
  const verify = () => {
    if (code.length !== CODE_LENGTH) {
      setError(null)
      setLocal({ message: t.verification.codeIncomplete })
      return
    }
    limits.mark('verify')
    void run('verify', async (stillCurrent) => {
      // The client shows the user it answers in its state, which is where the profile's
      // address is from.
      await withStepUp(() => client.user.email.verify({ code }))
      if (stillCurrent()) {
        close('title')
        setMessage(t.emailAddress.added)
      }
    })
  }

  // For an account with no address only. It stays while it has something to say: the
  // address reaches the client's state a moment before the confirmation is set here, and
  // the confirmation and the focus must not vanish in between.
  const quiet = view === 'summary' && busy === null && message === null && error === null
  if (props.user.email !== null && quiet) {
    return null
  }
  const placed = placeErrors(error, (failed) =>
    view === 'address' && failed === 'email.invalid'
      ? 'address'
      : view === 'code' && failed.startsWith('verification.')
        ? 'code'
        : null
  )
  const fieldErrors = (field: 'address' | 'code') =>
    local ? [local.message] : (placed.fields[field] ?? [])
  const wait = limits.secondsLeft(view === 'code' ? 'verify' : 'send')
  const formError = (
    <FormError
      message={placed.form}
      detail={wait > 0 ? formatText(t.common.retryIn, { time: formatDuration(wait, t) }) : null}
    />
  )
  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId} headingRef={title}>
        {t.emailAddress.sectionTitle}
      </Heading>
      <div ref={body}>
        {view === 'address' ? (
          <Form onSubmit={send} failure={local ?? error} blocked={busy !== null || wait > 0}>
            {formError}
            <TextField
              label={t.emailAddress.addressLabel}
              name='email'
              type='email'
              autoComplete='email'
              value={address}
              onValue={(value) => {
                setAddress(value)
                setLocal(null)
              }}
              errors={fieldErrors('address')}
              required
            />
            <div className='tula-button-row'>
              <Button type='submit' pending={busy === 'send'} disabled={wait > 0}>
                {t.emailAddress.send}
              </Button>
              <Button kind='secondary' onClick={() => close('action')}>
                {t.emailAddress.cancel}
              </Button>
            </div>
          </Form>
        ) : view === 'code' ? (
          <Form onSubmit={verify} failure={local ?? error} blocked={busy !== null || wait > 0}>
            <p className='tula-text'>{formatText(t.emailAddress.checkInbox, { destination })}</p>
            {formError}
            <CodeField
              value={code}
              onValue={(value) => {
                setCode(value)
                setLocal(null)
              }}
              errors={fieldErrors('code')}
            />
            <div className='tula-button-row'>
              <Button type='submit' pending={busy === 'verify'} disabled={wait > 0}>
                {t.emailAddress.verify}
              </Button>
              <Button
                kind='secondary'
                onClick={() => {
                  setError(null)
                  setLocal(null)
                  setCode('')
                  show('address', 'field')
                }}
              >
                {t.emailAddress.differentAddress}
              </Button>
              <Button kind='secondary' onClick={() => close('action')}>
                {t.emailAddress.cancel}
              </Button>
            </div>
          </Form>
        ) : props.user.email === null ? (
          <>
            <FormError message={error?.message ?? null} />
            <p className='tula-text'>{t.emailAddress.none}</p>
            <div className='tula-button-row tula-is-compact'>
              <Button
                kind='secondary'
                disabled={busy !== null}
                onClick={() => {
                  setError(null)
                  setMessage(null)
                  show('address', 'field')
                }}
              >
                {t.emailAddress.add}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <Status message={message} />
    </section>
  )
}
