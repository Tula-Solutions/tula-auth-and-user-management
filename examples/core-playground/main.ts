// A manual test bench for @tula/core in a real browser. Everything here goes through the
// SDK's public API; the only extra is a `fetch` wrapper that counts refresh requests, so the
// page can show that concurrent `getToken()` calls share one.
import {
  type ClientConfig,
  createTulaClient,
  evaluatePassword,
  isTulaError,
  type PasswordResetFlow,
  type SignInFlow,
  type SignUpFlow,
  type TulaClient,
} from '../../packages/core/src/index'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) {
    throw new Error(`playground: missing #${id}`)
  }
  return found as T
}

function fields(form: HTMLFormElement): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, value] of new FormData(form)) {
    values[name] = String(value)
  }
  return values
}

const log = element<HTMLOListElement>('log')

function record(kind: 'ok' | 'error' | 'info', text: string): void {
  const item = document.createElement('li')
  item.className = kind
  item.textContent = `${new Date().toLocaleTimeString()}  ${text}`
  log.prepend(item)
}

/** Run one SDK call, logging its result or its error's code. Never logs a token or a password. */
async function attempt<T>(label: string, call: () => Promise<T>, describe?: (result: T) => string) {
  try {
    const result = await call()
    record('ok', `${label} → ${describe ? describe(result) : 'ok'}`)
    return result
  } catch (error) {
    if (isTulaError(error)) {
      const fieldErrors = error.errors.map((problem) => `${problem.field}: ${problem.code}`)
      const retry = error.retryAfterMs === undefined ? '' : ` retryAfterMs=${error.retryAfterMs}`
      record(
        'error',
        `${label} → ${error.code} (${error.status}) "${error.message}"${retry}` +
          (fieldErrors.length > 0 ? ` [${fieldErrors.join(', ')}]` : '')
      )
    } else {
      record('error', `${label} → not a TulaError: ${String(error)}`)
    }
    return undefined
  } finally {
    render()
  }
}

const query = new URLSearchParams(location.search)
const api = query.get('api') ?? ''
const key = query.get('key') ?? ''
const connectForm = element<HTMLFormElement>('connect-form')
;(connectForm.elements.namedItem('api') as HTMLInputElement).value = api || 'http://localhost:3003'
;(connectForm.elements.namedItem('key') as HTMLInputElement).value = key

let refreshRequests = 0
let lastToken: string | null = null
let config: ClientConfig | null = null
let tula: TulaClient | null = null
const flows: { signUp?: SignUpFlow; signIn?: SignInFlow; reset?: PasswordResetFlow } = {}

function client(): TulaClient {
  if (!tula) {
    throw new Error('Connect first: enter the API URL and a publishable key.')
  }
  return tula
}

/** Seconds until the token's own `exp`, read from its payload. For display only. */
function describeToken(token: string | null): string {
  if (!token) {
    return 'none'
  }
  try {
    const payload = JSON.parse(
      atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))
    )
    const seconds = Math.round(payload.exp - Date.now() / 1000)
    const tail = token.slice(-8)
    return seconds > 0
      ? `…${tail}: expires in ${seconds}s (getToken() refreshes it in the last 10s)`
      : `…${tail}: expired ${-seconds}s ago (the next getToken() refreshes)`
  } catch {
    return 'unreadable'
  }
}

function render(): void {
  element('state').textContent = tula ? JSON.stringify(tula.state, null, 2) : 'not connected'
  element('token').textContent = describeToken(lastToken)
  element('refresh-count').textContent = String(refreshRequests)
  element('config').textContent = config
    ? `${config.app.name}: methods ${config.signIn.methods.join(', ')}; password min ${config.password.minLength}`
    : 'not loaded'
  element('sign-up-flow').textContent = flows.signUp
    ? JSON.stringify(flows.signUp, null, 2)
    : 'no flow'
  element('sign-in-flow').textContent = flows.signIn
    ? JSON.stringify(flows.signIn, null, 2)
    : 'no flow'
  element('reset-flow').textContent = flows.reset ? JSON.stringify(flows.reset, null, 2) : 'no flow'
}

function renderChecklist(password: string, email: string): void {
  const list = element<HTMLUListElement>('checklist')
  list.replaceChildren()
  if (!config || password === '') {
    return
  }
  for (const check of evaluatePassword(config.password, password, { email }).checks) {
    const item = document.createElement('li')
    item.className = check.passed ? 'passed' : 'failed'
    item.textContent = `${check.rule}${check.params ? ` ${JSON.stringify(check.params)}` : ''}`
    list.append(item)
  }
}

async function showToken(label: string, call: () => Promise<string | null>): Promise<void> {
  const token = await attempt(label, call, (result) =>
    result ? `token …${result.slice(-8)}` : 'null'
  )
  if (token !== undefined) {
    lastToken = token
  }
  render()
}

function onSubmit(id: string, handler: (values: Record<string, string>) => Promise<void>): void {
  element<HTMLFormElement>(id).addEventListener('submit', (event) => {
    event.preventDefault()
    void handler(fields(event.currentTarget as HTMLFormElement))
  })
}

function onClick(id: string, handler: () => Promise<void>): void {
  element<HTMLButtonElement>(id).addEventListener('click', () => void handler())
}

if (api && key) {
  try {
    tula = createTulaClient({
      publishableKey: key,
      baseUrl: api,
      client: 'web',
      fetch: (request) => {
        if (new URL(request.url).pathname.endsWith('/sessions/refresh')) {
          refreshRequests += 1
        }
        return fetch(request)
      },
      onSessionChange: (state) => {
        record('info', `state changed → ${state.status}`)
        if (state.status !== 'signed-in') {
          lastToken = null
        }
        render()
      },
    })
    void attempt(
      'config.get()',
      () => client().config.get(),
      (result) => result.app.name
    ).then((result) => {
      config = result ?? null
      render()
    })
    void attempt(
      'load()',
      () => client().load(),
      (state) => state.status
    )
  } catch (error) {
    record('error', `createTulaClient → ${String(error)}`)
  }
}

onClick('load', async () => {
  await attempt(
    'load()',
    () => client().load(),
    (state) => state.status
  )
})
onClick('get-token', () => showToken('session.getToken()', () => client().session.getToken()))
onClick('refresh', () => showToken('session.refresh()', () => client().session.refresh()))
onClick('get-token-10', async () => {
  const before = refreshRequests
  const tokens = await attempt(
    'session.getToken() ×10',
    () => Promise.all(Array.from({ length: 10 }, () => client().session.getToken())),
    (results) => `${new Set(results).size} distinct token(s)`
  )
  const made = refreshRequests - before
  element('concurrency-result').textContent = tokens
    ? `10 concurrent calls → ${new Set(tokens).size} distinct token, ${made} refresh request(s)`
    : ''
  lastToken = tokens?.[0] ?? lastToken
  render()
})
onClick('get-user', async () => {
  await attempt(
    'user.get()',
    () => client().user.get(),
    (user) => user.email
  )
})
onClick('sign-out', async () => {
  await attempt('session.signOut()', () => client().session.signOut())
})

const signUpForm = element<HTMLFormElement>('sign-up-form')
signUpForm.addEventListener('input', () => {
  const values = fields(signUpForm)
  renderChecklist(values.password ?? '', values.email ?? '')
})
onSubmit('sign-up-form', async ({ email = '', password = '', firstName }) => {
  flows.signUp = await attempt(
    'signUp.start()',
    () => client().signUp.start({ email, password, ...(firstName ? { firstName } : {}) }),
    (flow) => flow.step.status
  )
})
onSubmit('sign-up-code-form', async ({ code = '' }) => {
  const flow = flows.signUp
  if (flow) {
    await attempt(
      'signUp verifyEmail()',
      () => flow.verifyEmail({ code }),
      (step) => step.status
    )
  }
})
onClick('sign-up-resend', async () => {
  const flow = flows.signUp
  if (flow) {
    await attempt(
      'signUp resendCode()',
      () => flow.resendCode(),
      (step) => step.status
    )
  }
})

onSubmit('sign-in-form', async ({ identifier = '', password = '' }) => {
  const flow = await attempt(
    'signIn.start()',
    () => client().signIn.start({ identifier }),
    (started) => started.step.status
  )
  flows.signIn = flow
  if (flow) {
    await attempt(
      'signIn submitPassword()',
      () => flow.submitPassword({ password }),
      (step) => step.status
    )
  }
})
onSubmit('sign-in-code-form', async ({ code = '' }) => {
  const flow = flows.signIn
  if (flow) {
    await attempt(
      'signIn verifyEmail()',
      () => flow.verifyEmail({ code }),
      (step) => step.status
    )
  }
})

async function listSessions(): Promise<void> {
  const sessions = await attempt(
    'session.list()',
    () => client().session.list(),
    (all) => `${all.length} session(s)`
  )
  const list = element<HTMLUListElement>('sessions')
  list.replaceChildren()
  for (const session of sessions ?? []) {
    const item = document.createElement('li')
    item.textContent = `${session.current ? '(this one) ' : ''}${session.client} · ${session.userAgent ?? 'unknown'} · last active ${session.lastActiveAt} `
    const revoke = document.createElement('button')
    revoke.textContent = 'revoke'
    revoke.addEventListener('click', () => {
      void attempt(`session.revoke(${session.id.slice(0, 8)}…)`, () =>
        client().session.revoke(session.id)
      ).then(() => (client().state.status === 'signed-in' ? listSessions() : undefined))
    })
    item.append(revoke)
    list.append(item)
  }
}
onClick('list-sessions', listSessions)
onClick('revoke-others', async () => {
  await attempt(
    'session.revokeOthers()',
    () => client().session.revokeOthers(),
    (count) => `${count} ended`
  )
  await listSessions()
})

onSubmit('change-password-form', async ({ currentPassword = '', newPassword = '' }) => {
  await attempt('user.changePassword()', () =>
    client().user.changePassword({ currentPassword, newPassword })
  )
})

onSubmit('reset-form', async ({ email = '' }) => {
  flows.reset = await attempt(
    'resetPassword.start()',
    () => client().resetPassword.start({ email }),
    (flow) => flow.step.status
  )
})
onSubmit('reset-submit-form', async ({ code = '', password = '' }) => {
  const flow = flows.reset
  if (flow) {
    await attempt(
      'resetPassword submit()',
      () => flow.submit({ code, password }),
      (step) => step.status
    )
  }
})

// The countdown only re-reads the token this page already holds; it never asks for a new one.
setInterval(render, 1_000)
render()
