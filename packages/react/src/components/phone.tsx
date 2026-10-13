import { isStepUpRequired, type TulaError, type User } from '@tula/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useClientConfig } from '../hooks/use-password-checklist'
import { useStepUp } from '../hooks/use-step-up'
import { formatText } from '../localization'
import { CODE_LENGTH, CodeField, useRetryAfter } from './flow-screens'
import { formatDuration, placeErrors } from './form-errors'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

/** The codes the API answers about the number that was typed: said at its field. */
const NUMBER_CODES: ReadonlySet<string> = new Set(['phone.invalid', 'sms.country_not_allowed'])

/** Which screen the section shows: the number as it is, the number form, or the code form. */
type View = 'summary' | 'number' | 'code'

/**
 * "Phone number": the account's number, and adding, changing and removing it (ADR 0037).
 *
 * Adding is two steps the server decides: a code is texted to the number, and the code makes
 * the number the account's. The component holds no rule about what a phone number is, which
 * countries can be texted or when a step-up is needed: it sends what was typed, shows the
 * refusal's message at the field it is about, and runs every call through `useStepUp`.
 *
 * The typed number and the code are state only while their form is shown. The section is
 * keyed by the session in the profile, and an answer that arrives for a session that is no
 * longer the current one sets nothing.
 *
 * Shown when the app can text a code (`phone.enabled` in the client config) or the user has
 * a number; with text messages off a number can still be seen and removed.
 */
export function PhoneSection(props: { user: User }) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const offered = useClientConfig()?.phone?.enabled === true
  const withStepUp = useStepUp()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>('summary')
  const [number, setNumber] = useState('')
  const [code, setCode] = useState('')
  const [digits, setDigits] = useState('')
  const [busy, setBusy] = useState<'send' | 'verify' | 'remove' | null>(null)
  const [error, setError] = useState<TulaError | null>(null)
  const [local, setLocal] = useState<{ message: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Where the focus goes once the next screen is drawn; `null` leaves it where it is.
  const [focus, setFocus] = useState<{ on: 'field' | 'title' | 'action' } | null>(null)
  const mounted = useRef(true)
  const limits = useRetryAfter<'send' | 'verify'>(error)
  const current = props.user.phoneNumber ?? null

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
    setNumber('')
    setCode('')
    setDigits('')
    setError(null)
    setLocal(null)
    show('summary', on)
  }

  const send = () => {
    if (number.trim() === '') {
      setError(null)
      setLocal({ message: t.common.required })
      return
    }
    limits.mark('send')
    void run('send', async (stillCurrent) => {
      const sent = await withStepUp(() => client.user.phone.request({ phoneNumber: number }))
      if (stillCurrent()) {
        // The server's mask ends in the number's last digits; nothing else of it is shown.
        setDigits(sent.destination.replace(/\D/g, ''))
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
      // The client shows the user it answers in its state, which is where `current` is from.
      await withStepUp(() => client.user.phone.verify({ code }))
      if (stillCurrent()) {
        close('title')
        setMessage(t.phone.added)
      }
    })
  }
  const remove = () =>
    run('remove', async (stillCurrent) => {
      await withStepUp(() => client.user.phone.remove())
      if (stillCurrent()) {
        setMessage(t.phone.removed)
        // The number and its buttons are gone: the section's title is where reading resumes.
        setFocus({ on: 'title' })
      }
    })

  // With text messages off the section is for the number the user still has. It also stays
  // while a change is being made and for as long as it has something to say about it: the
  // number leaves the client's state a moment before the removal is confirmed here, and the
  // confirmation and the focus must not vanish in between.
  const quiet = view === 'summary' && busy === null && message === null && error === null
  if (!offered && current === null && quiet) {
    return null
  }
  const placed = placeErrors(error, (failed) =>
    view === 'number' && NUMBER_CODES.has(failed)
      ? 'number'
      : view === 'code' && failed.startsWith('verification.')
        ? 'code'
        : null
  )
  const fieldErrors = (field: 'number' | 'code') =>
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
        {t.phone.sectionTitle}
      </Heading>
      <div ref={body}>
        {view === 'number' ? (
          <Form onSubmit={send} failure={local ?? error} blocked={busy !== null || wait > 0}>
            {formError}
            <TextField
              label={t.phone.numberLabel}
              hint={t.phone.numberHint}
              name='tel'
              type='tel'
              inputMode='tel'
              autoComplete='tel'
              value={number}
              onValue={(value) => {
                setNumber(value)
                setLocal(null)
              }}
              errors={fieldErrors('number')}
              required
            />
            <div className='tula-button-row'>
              <Button type='submit' pending={busy === 'send'} disabled={wait > 0}>
                {t.phone.send}
              </Button>
              <Button kind='secondary' onClick={() => close('action')}>
                {t.phone.cancel}
              </Button>
            </div>
          </Form>
        ) : view === 'code' ? (
          <Form onSubmit={verify} failure={local ?? error} blocked={busy !== null || wait > 0}>
            <p className='tula-text'>{formatText(t.phone.codeSent, { digits })}</p>
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
                {t.phone.verify}
              </Button>
              <Button
                kind='secondary'
                onClick={() => {
                  setError(null)
                  setLocal(null)
                  setCode('')
                  show('number', 'field')
                }}
              >
                {t.phone.differentNumber}
              </Button>
              <Button kind='secondary' onClick={() => close('action')}>
                {t.phone.cancel}
              </Button>
            </div>
          </Form>
        ) : (
          <>
            <FormError message={error?.message ?? null} />
            {current === null ? (
              <p className='tula-text'>{t.phone.none}</p>
            ) : (
              <p className='tula-text'>
                <span dir='ltr'>{current}</span>{' '}
                <span {...el('badge', 'tula-is-positive')}>{t.phone.verified}</span>
              </p>
            )}
            <div className='tula-button-row tula-is-compact'>
              {offered ? (
                <Button
                  kind='secondary'
                  disabled={busy !== null}
                  onClick={() => {
                    setError(null)
                    setMessage(null)
                    show('number', 'field')
                  }}
                  aria-label={current === null ? undefined : t.phone.changeLabel}
                >
                  {current === null ? t.phone.add : t.phone.change}
                </Button>
              ) : null}
              {current === null ? null : (
                <Button
                  kind='danger'
                  pending={busy === 'remove'}
                  onClick={remove}
                  aria-label={t.phone.removeLabel}
                >
                  {t.phone.remove}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <Status message={message} />
    </section>
  )
}
