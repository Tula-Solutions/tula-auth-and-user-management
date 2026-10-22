import { useEffect, useState } from 'react'
import {
  DEMO_EMAIL,
  DEMO_MFA_EMAIL,
  DEMO_PASSWORD,
  type Sandbox,
  type SandboxEmail,
  totpNow,
} from '../sandbox'
import { CopyButton } from './code-view'
import { useNow, useWorld } from './hooks'

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function Message(props: {
  email: SandboxEmail
  sandbox: Sandbox
  onOpen(url: string, where: 'here' | 'other'): void
}) {
  const { email, sandbox, onOpen } = props
  return (
    <li className='pg-mail' data-expired={email.expired ? '' : undefined}>
      <div className='pg-mail-head'>
        <strong>{email.subject}</strong>
        <time>{timeOf(email.sentAt)}</time>
      </div>
      <p className='pg-muted'>To {email.to}</p>
      <p className='pg-mail-text'>{email.text}</p>
      {email.code ? (
        <p className='pg-mail-code'>
          <code>{email.code}</code>
          <CopyButton text={email.code} label='Copy code' />
        </p>
      ) : null}
      {email.link ? (
        <div className='pg-row'>
          <button
            type='button'
            className='pg-btn'
            disabled={email.expired}
            onClick={() => onOpen(email.link as string, 'here')}
          >
            Open link in this browser
          </button>
          <button
            type='button'
            className='pg-btn'
            disabled={email.expired}
            onClick={() => onOpen(email.link as string, 'other')}
          >
            Open in another browser
          </button>
        </div>
      ) : null}
      {email.code || email.link ? (
        <label className='pg-expire'>
          <input
            type='checkbox'
            checked={email.expired}
            onChange={(event) => {
              email.expired = event.target.checked
              sandbox.world.changed()
            }}
          />
          Treat this message as expired
        </label>
      ) : null}
    </li>
  )
}

/**
 * The sandbox's inbox: every email the service would have sent, with its code and link. A
 * code can be marked expired to see the expired-code screen.
 *
 * @param props - The sandbox, and what to do with a link that is opened.
 * @returns The inbox.
 */
export function Inbox(props: {
  sandbox: Sandbox
  onOpen(url: string, where: 'here' | 'other'): void
}) {
  useWorld(props.sandbox.world)
  const mails = [...props.sandbox.world.inbox].reverse()
  return mails.length ? (
    <ul className='pg-mails' aria-label='Sandbox emails'>
      {mails.map((email) => (
        <Message key={email.id} email={email} sandbox={props.sandbox} onOpen={props.onOpen} />
      ))}
    </ul>
  ) : (
    <p className='pg-empty'>
      No email yet. When a screen says it sent a code or a link, it appears here: nothing leaves
      your browser.
    </p>
  )
}

function Code(props: { secret: string; now: number }) {
  const [code, setCode] = useState('······')
  useEffect(() => {
    let current = true
    totpNow(props.secret, props.now).then((value) => current && setCode(value))
    return () => {
      current = false
    }
  }, [props.secret, props.now])
  const left = 30 - (Math.floor(props.now / 1000) % 30)
  return (
    <span className='pg-totp'>
      <code>{code}</code>
      <small>{left}s</small>
    </span>
  )
}

/**
 * The demo accounts, and the codes of every authenticator app in the sandbox. A real
 * authenticator app is a separate device; this panel stands in for it.
 *
 * @param props - The sandbox.
 * @returns The panel.
 */
export function Accounts({ sandbox }: { sandbox: Sandbox }) {
  useWorld(sandbox.world)
  const now = useNow(1000)
  const withTotp = [...sandbox.world.users.values()].filter((user) => user.totp)
  return (
    <div className='pg-accounts'>
      <dl className='pg-defs'>
        <div>
          <dt>Ada, no second step</dt>
          <dd>
            <code>{DEMO_EMAIL}</code>
          </dd>
        </div>
        <div>
          <dt>Grace, with an authenticator app</dt>
          <dd>
            <code>{DEMO_MFA_EMAIL}</code>
          </dd>
        </div>
        <div>
          <dt>Password for both</dt>
          <dd>
            <code>{DEMO_PASSWORD}</code> <CopyButton text={DEMO_PASSWORD} label='Copy password' />
          </dd>
        </div>
        <div>
          <dt>Grace's backup codes</dt>
          <dd>
            <code>sbx1-aaaa</code> to <code>sbx1-dddd</code> (each works once)
          </dd>
        </div>
      </dl>
      <h3 className='pg-subtitle'>Authenticator app</h3>
      {withTotp.length ? (
        <ul className='pg-totps'>
          {withTotp.map((user) => (
            <li key={user.id}>
              <span>
                {user.email}
                {user.totp?.confirmedAt ? '' : ' (not confirmed yet)'}
              </span>
              <Code secret={(user.totp as { secret: string }).secret} now={now} />
            </li>
          ))}
        </ul>
      ) : (
        <p className='pg-empty'>No account has an authenticator app yet.</p>
      )}
    </div>
  )
}
