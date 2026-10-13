import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import {
  PROPOSAL_APPROVAL_REFUSALS,
  PROPOSAL_FAILURE_REASONS,
  PROPOSAL_OPERATIONS,
} from '@tula-tech/contract'
import { useNow } from '~/features/proposals/proposals-screen'
import {
  FAKE_AGENT_KEY_ID,
  type FakeProposal,
  failure,
  fakeProposal,
  IDS,
  installFakeApi,
} from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  holdAnswers,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

// The proposals screen: what an agent asked for and nobody has approved yet, and the
// approval of one with the dashboard's session. Rendered as the whole app, against the fake
// API.

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const ENVIRONMENT = 'x-tula-environment'
const APPROVE = /^\/v1\/admin\/proposals\/[^/]+\/approve$/
const SPENT = 'The proposal is spent: it cannot be approved again.'
const MAYBE =
  'If the request reached the server the proposal may have been approved all the same: the list is being read again, check how it stands before trying once more.'

/** A time by this browser's clock, for a countdown that is still running. */
function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/** The app on the proposals screen of an environment that has these proposals. */
function withProposals(proposals: Partial<FakeProposal>[], path = DEV_PATH): World {
  const api = installFakeApi()
  const environmentId = path === PROD_PATH ? IDS.production : IDS.development
  api.state.proposals.push(
    ...proposals.map((proposal) =>
      fakeProposal({ environmentId, expiresAt: inMinutes(9), ...proposal })
    )
  )
  return start(`${path}/proposals`, { api })
}

async function cards(): Promise<HTMLElement[]> {
  return screen.findAllByTestId('proposal')
}

async function onlyCard(): Promise<HTMLElement> {
  const all = await cards()
  expect(all).toHaveLength(1)
  return all[0] as HTMLElement
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function approvals(api: World['api']) {
  return api.calls.filter((call) => call.method === 'POST' && APPROVE.test(call.path))
}

function lists(api: World['api']): number {
  return api.callsTo('GET', '/v1/admin/proposals').length
}

async function result(): Promise<HTMLElement> {
  return screen.findByTestId('approval-result')
}

/** Open the question for the one waiting proposal and answer it. */
async function approveTheOne(current: World): Promise<void> {
  const card = await onlyCard()
  await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
  await current.user.click(within(dialog()).getByRole('button', { name: 'Approve' }))
}

describe('the list', () => {
  test('the navigation leads to it; with nothing waiting it says so, and that nothing is dismissed', async () => {
    const { user, location, api } = start(`${DEV_PATH}/users`)
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    await user.click(screen.getByRole('link', { name: 'Proposals' }))
    await screen.findByRole('heading', { level: 1, name: 'Proposals' })
    expect(location()).toBe(`${DEV_PATH}/proposals`)
    await screen.findByText('No proposal is waiting')
    expect(screen.getByText('No earlier proposal: none has expired or been approved.')).toBeTruthy()
    const note = screen.getByTestId('proposals-no-dismiss').textContent ?? ''
    expect(note).toContain('it cannot be dismissed here')
    expect(note).toContain('expires by itself ten minutes after it was asked for')
    expect(screen.queryAllByRole('button', { name: /dismiss|reject/i })).toHaveLength(0)
    expect(api.callsTo('GET', '/v1/admin/proposals').at(-1)?.headers.get(ENVIRONMENT)).toBe(
      IDS.development
    )
  })

  test('a waiting proposal says the server’s sentence, the exact operation, the target as it is now, the agent and the time left', async () => {
    withProposals([{}])
    const card = await onlyCard()
    expect(card.getAttribute('data-status')).toBe('pending')
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe(
      `ban_user for user ${IDS.user}`
    )
    expect(within(card).getByTestId('proposal-summary').textContent).toBe(
      `Ban the user ${IDS.user}: every session of theirs ends now, and they cannot sign in until an administrator lifts the ban.`
    )
    expect(within(card).getByTestId('proposal-state').textContent).toBe(
      'Waiting for approvalNothing has happened. It can be approved once, until it expires.'
    )
    await waitFor(() =>
      expect(within(card).getByTestId('proposal-target').textContent).toBe(
        `user ${IDS.user} (ada@example.com, Ada Lovelace; not banned now)`
      )
    )
    expect(card.textContent).toContain(`An agent (agent key ${FAKE_AGENT_KEY_ID})`)
    const left = within(card).getByTestId('proposal-time-left')
    expect(left.textContent).toMatch(/^[89] min \d+ s left\.$/)
    // The countdown ticks every second and is never announced: no live region holds it.
    expect(left.closest('[aria-live], [role="status"], [role="alert"], [role="timer"]')).toBeNull()
    expect(
      within(card).getByRole('button', { name: `Approve ban_user for user ${IDS.user}` })
    ).toBeTruthy()
  })

  test('a session, a provider and a user that is gone are described from what the environment has now', async () => {
    const gone = '00000000-0000-7000-8000-0000000000dd'
    withProposals([
      { operation: 'unban_user', target: { type: 'user', id: gone } },
      { operation: 'disable_oauth_provider', target: { type: 'oauth_provider', id: 'google' } },
      { operation: 'end_session', target: { type: 'session', id: IDS.session } },
    ])
    await waitFor(() =>
      expect(screen.getAllByTestId('proposal-target').map((line) => line.textContent)).toEqual([
        `session ${IDS.session} (of user ${IDS.user}: ada@example.com, Ada Lovelace; web client, signed in ${new Intl.DateTimeFormat(
          undefined,
          { dateStyle: 'medium', timeStyle: 'short' }
        ).format(new Date('2026-10-04T12:00:00.000Z'))}; live now)`,
        'provider google (not configured now)',
        `user ${gone} (no such user now)`,
      ])
    )
  })

  test('a target that cannot be read says so in fixed words, with nothing of the failure', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/admin\/users\/[^/]+$/, () =>
      failure(503, 'service.unavailable', 'CANARY-driver-text')
    )
    api.override('GET', /^\/v1\/admin\/sessions\/[^/]+$/, () =>
      failure(503, 'service.unavailable', 'CANARY-driver-text')
    )
    api.override('GET', /^\/v1\/admin\/oauth-providers$/, () =>
      failure(503, 'service.unavailable', 'CANARY-driver-text')
    )
    api.state.proposals.push(
      fakeProposal({ expiresAt: inMinutes(9) }),
      fakeProposal({
        expiresAt: inMinutes(9),
        operation: 'end_session',
        target: { type: 'session', id: IDS.session },
      }),
      fakeProposal({
        expiresAt: inMinutes(9),
        operation: 'disable_oauth_provider',
        target: { type: 'oauth_provider', id: 'github' },
      })
    )
    start(`${DEV_PATH}/proposals`, { api })
    await waitFor(() =>
      expect(screen.getAllByTestId('proposal-target').map((line) => line.textContent)).toEqual([
        'provider github (could not be read)',
        `session ${IDS.session} (could not be read)`,
        `user ${IDS.user} (the user could not be read)`,
      ])
    )
    expect(document.body.textContent).not.toContain('CANARY')
  })

  test('an expired proposal and one whose agent key was revoked cannot be approved, and say so', async () => {
    const current = withProposals([{ keyRevoked: true }, { expiresAt: '2026-10-04T11:00:00.000Z' }])
    const all = await cards()
    expect(all.map((card) => card.getAttribute('data-status'))).toEqual(['expired', 'expired'])
    expect(all.map((card) => within(card).getByTestId('proposal-state').textContent)).toEqual([
      'ExpiredIt was not approved in time, and nothing was changed. It cannot be approved any more; the agent can ask again.',
      'Expired: agent key revokedThe agent key that asked for it was revoked, and nothing was changed. What a revoked key asked for is never carried out: it cannot be approved.',
    ])
    expect(screen.queryAllByRole('button', { name: /^Approve/ })).toHaveLength(0)
    expect(screen.queryAllByTestId('proposal-time-left')).toHaveLength(0)
    screen.getByText('No proposal is waiting')
    expect(approvals(current.api)).toHaveLength(0)
  })

  test('a proposal that was used says how it ended and who approved it, and has no button', async () => {
    const approved = { type: 'admin', id: '00000000-0000-7000-8000-0000000000aa' }
    withProposals([
      { status: 'executed', approvedBy: approved, approvedAt: '2026-10-04T11:59:30.000Z' },
      {
        status: 'failed',
        failureReason: 'incomplete',
        approvedBy: { type: 'instance_admin', id: null },
        approvedAt: '2026-10-04T11:59:30.000Z',
      },
      { status: 'approved', approvedBy: approved, approvedAt: '2026-10-04T11:59:30.000Z' },
    ])
    const all = await cards()
    expect(all.map((card) => card.getAttribute('data-status'))).toEqual([
      'approved',
      'failed',
      'executed',
    ])
    const states = all.map((card) => within(card).getByTestId('proposal-state').textContent ?? '')
    expect(states[0]).toBe(
      `Approved, outcome not recordedIt was approved and its operation was started, and the server could not record how the operation ended. Check the user as it is now. ${SPENT}`
    )
    expect(states[1]).toStartWith(
      'Approved, only partly carried outApproved, and only partly carried out. The user is banned, and ending their sessions failed'
    )
    expect(states[2]).toBe(`Approved and carried out${SPENT}`)
    expect(all[2]?.textContent).toContain(`admin ${approved.id}`)
    expect(all[1]?.textContent).toContain('instance_admin,')
    expect(screen.queryAllByRole('button', { name: /^Approve/ })).toHaveLength(0)
  })

  test('an operation this version does not know is shown and cannot be approved', async () => {
    const current = withProposals([
      { operation: 'delete_everything', summary: 'Delete everything.' },
      { status: 'archived' as never },
    ])
    const all = await cards()
    const unknown = all.find((card) => card.getAttribute('data-status') === 'pending')
    expect(
      within(unknown as HTMLElement).getByTestId('proposal-unknown-operation').textContent
    ).toBe(
      'This version of the dashboard does not know this operation, and does not approve what it cannot describe. Nothing was changed.'
    )
    const strange = all.find((card) => card.getAttribute('data-status') === 'unknown')
    expect(within(strange as HTMLElement).getByTestId('proposal-state').textContent).toBe(
      'archivedThis version of the dashboard does not know this status. It is not waiting for approval here.'
    )
    expect(screen.queryAllByRole('button', { name: /^Approve/ })).toHaveLength(0)
    expect(approvals(current.api)).toHaveLength(0)
  })

  test('text from the server is text: markup is not built, and what cannot be seen is written out', async () => {
    const api = installFakeApi()
    const hostile =
      '<script>window.canary = 1</script><img src=x onerror="window.canary = 1"><b>bold</b>'
    api.state.users[0] = {
      ...(api.state.users[0] as (typeof api.state.users)[number]),
      email: 'ada\u{202E}@example.com',
      firstName: '<i>Ada</i>',
      lastName: 'Love\u{200B}lace',
    }
    api.state.proposals.push(
      fakeProposal({ expiresAt: inMinutes(9), summary: hostile }),
      fakeProposal({
        expiresAt: inMinutes(9),
        operation: 'ban\u{200B}_user',
        target: { type: 'us\u{202E}er', id: 'a\u{200B}b' },
        summary: 'hidden',
      })
    )
    start(`${DEV_PATH}/proposals`, { api })
    const all = await cards()
    const main = document.querySelector('main') ?? document.body
    expect(main.querySelectorAll('script, img, b, i')).toHaveLength(0)
    expect((window as unknown as { canary?: number }).canary).toBeUndefined()
    expect(within(all[1] as HTMLElement).getByTestId('proposal-summary').textContent).toBe(hostile)
    await waitFor(() =>
      expect(within(all[1] as HTMLElement).getByTestId('proposal-target').textContent).toBe(
        `user ${IDS.user} (ada\\u{202E}@example.com, <i>Ada</i>\\u{20}Love\\u{200B}lace; not banned now)`
      )
    )
    // An operation and a target that hide a character are shown with it written out, and
    // are nothing this version knows: there is no button.
    expect(within(all[0] as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(
      'ban\\u{200B}_user for us\\u{202E}er a\\u{200B}b'
    )
    expect(within(all[0] as HTMLElement).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('approving', () => {
  test.each(
    PROPOSAL_OPERATIONS.map((operation) => {
      const targets = {
        ban_user: { type: 'user', id: IDS.user },
        unban_user: { type: 'user', id: IDS.user },
        end_session: { type: 'session', id: IDS.session },
        disable_oauth_provider: { type: 'oauth_provider', id: 'google' },
      } as const
      const said = {
        ban_user:
          'The user is banned at once: every session of theirs ends and they cannot sign in.',
        unban_user:
          'The user’s ban is lifted at once: they can sign in again. Sessions that were ended stay ended.',
        end_session:
          'That one session is ended at once: whoever holds it is signed out and has to sign in again.',
        disable_oauth_provider:
          'Sign-in with that provider is switched off at once: nobody signs in or signs up with it until it is switched on again. Its credentials are kept.',
      } as const
      return [operation, targets[operation], said[operation]] as const
    })
  )(
    '%s: the question names it, and what is sent is the operation and the target that were shown',
    async (operation, target, said) => {
      const api = installFakeApi()
      if (operation === 'unban_user') {
        ;(api.state.users[0] as { bannedAt: string | null }).bannedAt = '2026-10-04T10:00:00.000Z'
      }
      api.state.proposals.push(fakeProposal({ expiresAt: inMinutes(9), operation, target }))
      const current = start(`${DEV_PATH}/proposals`, { api })
      const card = await onlyCard()
      const what = { user: 'user', session: 'session', oauth_provider: 'provider' }[target.type]
      await current.user.click(
        within(card).getByRole('button', { name: `Approve ${operation} for ${what} ${target.id}` })
      )
      expect(within(dialog()).getByRole('heading').textContent).toBe(
        `Approve ${operation} for ${what} ${target.id}?`
      )
      expect(within(dialog()).getByTestId('approve-consequence').textContent).toBe(said)
      // A development environment asks for nothing to be typed.
      expect(within(dialog()).queryAllByRole('textbox')).toHaveLength(0)
      expect(approvals(api)).toHaveLength(0)

      await current.user.click(within(dialog()).getByRole('button', { name: 'Approve' }))
      const panel = await result()
      expect(panel.getAttribute('data-outcome')).toBe('done')
      expect(panel.getAttribute('role')).toBe('status')
      expect(panel.textContent).toContain('Approved and carried out')
      expect(within(panel).getByTestId('approval-result-text').textContent).toBe(`${said} ${SPENT}`)
      expect(openDialogs()).toBe(0)
      await expectFocus(panel)

      const sent = approvals(api)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.path).toBe(`/v1/admin/proposals/${api.state.proposals[0]?.id}/approve`)
      expect(sent[0]?.body).toEqual({ operation, target })
      expect(sent[0]?.headers.get(ENVIRONMENT)).toBe(IDS.development)
      expect(sent[0]?.headers.get('authorization')).toBeNull()

      // The list was read again: the proposal is no longer waiting, and has no button.
      const after = await onlyCard()
      expect(after.getAttribute('data-status')).toBe('executed')
      screen.getByText('No proposal is waiting')
      await current.user.click(within(panel).getByRole('button', { name: 'Close this message' }))
      expect(screen.queryAllByTestId('approval-result')).toHaveLength(0)
    }
  )

  test('in a production environment the target’s id is typed before the approval is allowed', async () => {
    const current = withProposals([{}], PROD_PATH)
    const card = await onlyCard()
    await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
    const confirm = within(dialog()).getByRole('button', { name: 'Approve' })
    const field = within(dialog()).getByLabelText(`Type ${IDS.user} to confirm`)
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await current.user.click(confirm)
    await current.user.type(field, `${IDS.user.slice(0, -1)}{Enter}`)
    expect(approvals(current.api)).toHaveLength(0)
    expect(openDialogs()).toBe(1)

    await current.user.type(field, IDS.user.slice(-1))
    expect(confirm.getAttribute('aria-disabled')).toBeNull()
    await current.user.click(confirm)
    await result()
    const sent = approvals(current.api)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.headers.get(ENVIRONMENT)).toBe(IDS.production)
    expect(sent[0]?.body).toEqual({ operation: 'ban_user', target: { type: 'user', id: IDS.user } })
  })

  test('cancelling the question sends nothing and changes nothing', async () => {
    const current = withProposals([{}])
    const card = await onlyCard()
    const open = within(card).getByRole('button', { name: /^Approve / })
    await current.user.click(open)
    await current.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(approvals(current.api)).toHaveLength(0)
    expect(current.api.state.users[0]?.bannedAt).toBeNull()
    expect(screen.queryAllByTestId('approval-result')).toHaveLength(0)
  })

  test('a confirmed approval is sent once: not by a second click, not by Enter, not while the list is read again', async () => {
    const current = withProposals([{}], PROD_PATH)
    const card = await onlyCard()
    await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
    const field = within(dialog()).getByLabelText(`Type ${IDS.user} to confirm`)
    await current.user.type(field, IDS.user)
    const confirm = within(dialog()).getByRole('button', { name: 'Approve' })

    const approval = holdAnswers(
      (path, _headers, method) => method === 'POST' && APPROVE.test(path)
    )
    await current.user.click(confirm)
    await waitFor(() => expect(approval.held()).toBe(1))
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await current.user.click(confirm)
    await current.user.type(field, '{Enter}')
    expect(approvals(current.api)).toHaveLength(1)

    // The approval has succeeded and the list is being read again, for as long as it takes:
    // the answer is on the screen, the question is closed, and the card that still reads
    // `pending` cannot be asked about a second time.
    const reading = holdAnswers(
      (path, _headers, method) => method === 'GET' && path === '/v1/admin/proposals'
    )
    await act(() => approval.release())
    await result()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(reading.held()).toBeGreaterThan(0)
    const again = within(await onlyCard()).getByRole('button', { name: /^Approve / })
    expect(again.getAttribute('aria-disabled')).toBe('true')
    expect(again.getAttribute('aria-busy')).toBeNull()
    expect((await onlyCard()).textContent).toContain(
      'This screen has an answer about this proposal (above). The list is being read again.'
    )
    await current.user.click(again)
    expect(openDialogs()).toBe(0)
    expect(approvals(current.api)).toHaveLength(1)
  })

  test('a question closed while its approval is on the way starts no second approval, and the answer is still shown', async () => {
    const current = withProposals([
      {},
      { operation: 'end_session', target: { type: 'session', id: IDS.session } },
    ])
    const all = await cards()
    await current.user.click(
      within(all[1] as HTMLElement).getByRole('button', { name: /^Approve / })
    )
    const approval = holdAnswers(
      (path, _headers, method) => method === 'POST' && APPROVE.test(path)
    )
    await current.user.click(within(dialog()).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(approval.held()).toBe(1))
    await current.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))

    const mine = within(all[1] as HTMLElement).getByRole('button', { name: /^Approve / })
    expect(mine.getAttribute('aria-busy')).toBe('true')
    const other = within(all[0] as HTMLElement).getByRole('button', { name: /^Approve / })
    // Unavailable, in words, and not said to be busy: nothing of this card is on its way.
    expect(other.getAttribute('aria-disabled')).toBe('true')
    expect(other.getAttribute('aria-busy')).toBeNull()
    expect(
      document.getElementById(other.getAttribute('aria-describedby') ?? 'none')?.textContent
    ).toBe('Another approval is on its way: this one can be asked about once it is answered.')
    await current.user.click(other)
    expect(openDialogs()).toBe(0)
    await act(() => approval.release())
    const panel = await result()
    expect(panel.getAttribute('data-outcome')).toBe('done')
    expect(approvals(current.api)).toHaveLength(1)
  })
})

describe('what the server refuses', () => {
  const WORDS: Record<(typeof PROPOSAL_APPROVAL_REFUSALS)[number], string> = {
    expired: 'The proposal has expired. Nothing was changed. The agent can ask again.',
    already_decided:
      'The proposal was already approved, here or somewhere else: a proposal is approved once. This click changed nothing. How it ended is in the list.',
    mismatch:
      'The proposal is not the one that was shown: its operation or its target differs. Nothing was changed.',
    agent_key_revoked:
      'The agent key that asked for this was revoked: what a revoked key asked for is never carried out. Nothing was changed.',
    production_environment:
      'This is a production environment, and its settings do not (or no longer) accept proposals from an agent. Nothing was changed, and the proposal is not spent: it can still be approved before it expires if the setting is switched on (Settings, “AI agents”).',
  }

  test.each([...PROPOSAL_APPROVAL_REFUSALS])(
    '%s is said in fixed words, never the server’s, and the list is read again',
    async (reason) => {
      const current = withProposals([{}])
      current.api.override('POST', APPROVE, () =>
        failure(409, 'resource.conflict', 'CANARY-server-detail', undefined, { reason })
      )
      await onlyCard()
      const before = lists(current.api)
      await approveTheOne(current)
      const panel = await result()
      expect(panel.getAttribute('data-outcome')).toBe('refused')
      expect(panel.getAttribute('role')).toBe('alert')
      expect(panel.textContent).toContain('Not approved')
      expect(within(panel).getByTestId('approval-result-text').textContent).toBe(WORDS[reason])
      expect(document.body.textContent).not.toContain('CANARY')
      expect(openDialogs()).toBe(0)
      expect(lists(current.api)).toBeGreaterThan(before)
      expect(approvals(current.api)).toHaveLength(1)
      await expectFocus(panel)
    }
  )

  test('a proposal the server says has expired or was used meanwhile is refused by the real rules, and leaves the list as the server has it', async () => {
    const current = withProposals([{}])
    const card = await onlyCard()
    await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
    // It expires on the server while the question is open.
    current.api.state.proposalNow = new Date(Date.now() + 3_600_000).toISOString()
    await current.user.click(within(dialog()).getByRole('button', { name: 'Approve' }))
    const panel = await result()
    expect(within(panel).getByTestId('approval-result-text').textContent).toBe(WORDS.expired)
    expect((await onlyCard()).getAttribute('data-status')).toBe('expired')
    expect(screen.queryAllByRole('button', { name: /^Approve / })).toHaveLength(0)
    expect(current.api.state.users[0]?.bannedAt).toBeNull()
  })

  test('no answer: the question stays, says the approval may have been taken, and can be tried again', async () => {
    const current = withProposals([{}])
    let answers = 0
    current.api.override('POST', APPROVE, () => {
      answers += 1
      return failure(503, 'service.unavailable', 'The service is unavailable.')
    })
    await onlyCard()
    const before = lists(current.api)
    await approveTheOne(current)
    const alert = await within(dialog()).findByRole('alert')
    expect(alert.textContent).toBe(`The service is unavailable. ${MAYBE}`)
    await waitFor(() => expect(lists(current.api)).toBeGreaterThan(before))
    const confirm = within(dialog()).getByRole('button', { name: 'Approve' })
    await waitFor(() => expect(confirm.getAttribute('aria-disabled')).toBeNull())
    expect(screen.queryAllByTestId('approval-result')).toHaveLength(0)
    await current.user.click(confirm)
    await waitFor(() => expect(answers).toBe(2))
  })

  test('a refusal of the request itself is not said to have maybe been taken', async () => {
    const current = withProposals([{}])
    current.api.override('POST', APPROVE, () => failure(429, 'rate_limited', 'Too many requests.'))
    await onlyCard()
    await approveTheOne(current)
    const alert = await within(dialog()).findByRole('alert')
    expect(alert.textContent).toBe('Too many requests. Wait a moment, then try again.')
  })

  test('a reason this version does not know is said as any failure is, in the question', async () => {
    const current = withProposals([{}])
    current.api.override('POST', APPROVE, () =>
      failure(409, 'resource.conflict', 'Something else is in the way.', undefined, {
        reason: 'constructor',
      })
    )
    await onlyCard()
    await approveTheOne(current)
    const alert = await within(dialog()).findByRole('alert')
    expect(alert.textContent).toBe('Something else is in the way.')
    expect(screen.queryAllByTestId('approval-result')).toHaveLength(0)
  })
})

describe('what an approval came to', () => {
  /** The fake's answer to the approval: the proposal, spent, as the test says it ended. */
  function answering(current: World, ended: Record<string, unknown>) {
    current.api.override('POST', APPROVE, (call) => {
      const proposal = current.api.state.proposals.find((entry) => call.path.includes(entry.id))
      if (!proposal) {
        return failure(404, 'resource.not_found', 'Not found.')
      }
      proposal.status = ended.status as FakeProposal['status']
      proposal.failureReason = (ended.failureReason as string | null) ?? null
      proposal.approvedBy = { type: 'instance_admin', id: 'dash-session' }
      proposal.approvedAt = current.api.state.proposalNow
      const { environmentId: _e, keyRevoked: _k, ...rest } = proposal
      return { ...rest, summary: 'A summary.', expiryReason: null, ...ended }
    })
  }

  test.each([
    // The server does not answer a ban as unchanged today; the screen still has its words.
    ['ban_user', { type: 'user', id: IDS.user }, 'the user was already banned'],
    ['unban_user', { type: 'user', id: IDS.user }, 'the user was not banned'],
    ['end_session', { type: 'session', id: IDS.session }, 'the session had already ended'],
    [
      'disable_oauth_provider',
      { type: 'oauth_provider', id: 'google' },
      'the provider was already off',
    ],
  ])(
    '%s carried out with nothing to change says that nothing changed',
    async (operation, target, already) => {
      const current = withProposals([{ operation, target }])
      answering(current, { status: 'executed', changed: false })
      await onlyCard()
      await approveTheOne(current)
      const panel = await result()
      expect(panel.getAttribute('data-outcome')).toBe('nothing')
      expect(panel.textContent).toContain('Approved; nothing changed')
      expect(within(panel).getByTestId('approval-result-text').textContent).toBe(
        `Approved and carried out; ${already}, so nothing changed. ${SPENT}`
      )
    }
  )

  const FAILED: Record<(typeof PROPOSAL_FAILURE_REASONS)[number], [string, string]> = {
    target_not_found: [
      'Approved, and not carried out',
      `Approved, but nothing was changed: the user no longer exists. ${SPENT}`,
    ],
    error: [
      'Approved, and not carried out',
      `Approved, but the operation failed on the server (error). Check the user as it is now, and have the agent ask again if the change is still wanted. ${SPENT}`,
    ],
    incomplete: [
      'Approved, and only partly carried out',
      `Approved, and only partly carried out. The user is banned, and ending their sessions failed: a session of theirs may still be live until its access token runs out, and is refused at its next refresh. End them now, on the user’s page (“End all sessions”) or with DELETE /v1/admin/users/${IDS.user}/sessions. ${SPENT}`,
    ],
    last_sign_in_method: [
      'Approved, and not carried out',
      `Approved, but nothing was changed: switching this provider off would leave the environment with no way to sign in, which the server refuses for an administrator too. The provider is still on. ${SPENT}`,
    ],
  }

  test.each([...PROPOSAL_FAILURE_REASONS])(
    'failed with %s is never said as carried out, and says what is left to do',
    async (failureReason) => {
      const current = withProposals([{}])
      answering(current, { status: 'failed', failureReason })
      await onlyCard()
      await approveTheOne(current)
      const panel = await result()
      expect(panel.getAttribute('data-outcome')).toBe('problem')
      expect(panel.getAttribute('role')).toBe('alert')
      const [title, text] = FAILED[failureReason]
      expect(panel.textContent).toContain(title)
      expect(panel.textContent).not.toContain('Approved and carried out')
      expect(within(panel).getByTestId('approval-result-text').textContent).toBe(text)
      const link = within(panel).queryAllByRole('link', {
        name: 'Open the user’s page to end their sessions',
      })
      expect(link).toHaveLength(failureReason === 'incomplete' ? 1 : 0)
      if (failureReason === 'incomplete') {
        expect(link[0]?.getAttribute('href')).toBe(`/dashboard${DEV_PATH}/users/${IDS.user}`)
      }
      expect((await onlyCard()).getAttribute('data-status')).toBe('failed')
    }
  )

  test('an operation other than a ban that was only partly carried out says to check the target', async () => {
    const current = withProposals([
      { operation: 'end_session', target: { type: 'session', id: IDS.session } },
    ])
    answering(current, { status: 'failed', failureReason: 'incomplete' })
    await onlyCard()
    await approveTheOne(current)
    const panel = await result()
    expect(within(panel).getByTestId('approval-result-text').textContent).toBe(
      `Approved, and only partly carried out: the change was made and a later step failed. Check the session as it is now. ${SPENT}`
    )
    expect(within(panel).queryAllByRole('link')).toHaveLength(0)
  })

  test('an approval whose outcome the server could not record is not said as carried out', async () => {
    const current = withProposals([{}])
    answering(current, { status: 'approved' })
    await onlyCard()
    await approveTheOne(current)
    const panel = await result()
    expect(panel.getAttribute('data-outcome')).toBe('problem')
    expect(panel.textContent).toContain('Approved; how it ended is not known')
    expect(within(panel).getByTestId('approval-result-text').textContent).toBe(
      `Approved, and the server could not record how the operation ended. Check the user as it is now. ${SPENT}`
    )
  })
})

describe('the time left', () => {
  test('a proposal whose time is up by this browser’s clock is asked about again, once, and the server’s word stands', async () => {
    // The fake server's clock is before this expiry: it still says `pending`.
    const current = withProposals([{ expiresAt: '2026-10-04T12:09:00.000Z' }])
    const card = await onlyCard()
    expect(within(card).getByTestId('proposal-time-left').textContent).toBe(
      'The time is up by this browser’s clock: the server decides, and an approval now is likely refused.'
    )
    await waitFor(() => expect(lists(current.api)).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lists(current.api)).toBe(2)
    expect(card.getAttribute('data-status')).toBe('pending')
    within(card).getByRole('button', { name: /^Approve / })
  })

  test('the clock is a timer in an effect: it ticks while asked to, and is stopped when it is not or the screen goes', () => {
    const set = spyOn(globalThis, 'setInterval')
    const cleared = spyOn(globalThis, 'clearInterval')
    try {
      const hook = renderHook(({ ticking }: { ticking: boolean }) => useNow(ticking), {
        initialProps: { ticking: false },
      })
      expect(set).toHaveBeenCalledTimes(0)
      hook.rerender({ ticking: true })
      expect(set).toHaveBeenCalledTimes(1)
      hook.rerender({ ticking: false })
      expect(cleared).toHaveBeenCalledTimes(1)
      hook.rerender({ ticking: true })
      expect(set).toHaveBeenCalledTimes(2)
      hook.unmount()
      expect(cleared).toHaveBeenCalledTimes(2)
    } finally {
      set.mockRestore()
      cleared.mockRestore()
    }
  })
})

describe('the answer does not wait for the list', () => {
  const LIST = (path: string, _headers: Headers, method: string) =>
    method === 'GET' && path === '/v1/admin/proposals'

  test('a ban whose sessions were not ended is said at once, while the list never comes back', async () => {
    const current = withProposals([{}])
    current.api.override('POST', APPROVE, (call) => {
      const proposal = current.api.state.proposals.find((entry) => call.path.includes(entry.id))
      const { environmentId: _e, keyRevoked: _k, ...rest } = proposal as FakeProposal
      return {
        ...rest,
        summary: 'A summary.',
        expiryReason: null,
        status: 'failed',
        failureReason: 'incomplete',
        approvedBy: { type: 'instance_admin', id: 'dash-session' },
        approvedAt: current.api.state.proposalNow,
      }
    })
    await onlyCard()
    const reading = holdAnswers(LIST)
    await approveTheOne(current)
    const panel = await result()
    expect(reading.held()).toBeGreaterThan(0)
    expect(panel.getAttribute('data-outcome')).toBe('problem')
    expect(within(panel).getByTestId('approval-result-text').textContent).toContain(
      'The user is banned, and ending their sessions failed'
    )
    expect(
      within(panel).getByRole('link', { name: 'Open the user’s page to end their sessions' })
    ).toBeDefined()
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(panel)
    // Never released: the answer did not need it.
  })

  test('a refusal is said at once, while the list never comes back', async () => {
    const current = withProposals([{}])
    current.api.override('POST', APPROVE, () =>
      failure(409, 'resource.conflict', 'No.', undefined, { reason: 'agent_key_revoked' })
    )
    await onlyCard()
    const reading = holdAnswers(LIST)
    await approveTheOne(current)
    const panel = await result()
    expect(reading.held()).toBeGreaterThan(0)
    expect(panel.getAttribute('data-outcome')).toBe('refused')
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(approvals(current.api)).toHaveLength(1)
  })
})

describe('the question is about what the card showed', () => {
  test('what the question says the proposal is about does not change after it was opened', async () => {
    const current = withProposals([{}])
    const card = await onlyCard()
    await waitFor(() =>
      expect(within(card).getByTestId('proposal-target').textContent).toContain('not banned now')
    )
    const shown = within(card).getByTestId('proposal-target').textContent as string
    await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
    const about = within(dialog()).getByTestId('proposal-target')
    expect(about.textContent).toBe(shown)
    expect(dialog().textContent).toContain('as its card said when this question was opened.')
    expect(dialog().textContent).not.toContain('It had not been read then')

    // The user changes behind the open question, and the card reads it again.
    const user = current.api.state.users[0] as { email: string; bannedAt: string | null }
    user.email = 'someone-else@example.com'
    user.bannedAt = '2026-10-04T11:00:00.000Z'
    await act(() => current.queryClient.invalidateQueries())
    await waitFor(() =>
      expect(within(card).getByTestId('proposal-target').textContent).toContain(
        'someone-else@example.com'
      )
    )
    expect(within(dialog()).getByTestId('proposal-target').textContent).toBe(shown)
    expect(dialog().textContent).not.toContain('someone-else@example.com')
  })

  test('a question opened before the target was read says so, and does not fill in later', async () => {
    const current = withProposals([{}])
    const reading = holdAnswers(
      (path, _headers, method) => method === 'GET' && path === `/v1/admin/users/${IDS.user}`
    )
    const card = await onlyCard()
    await current.user.click(within(card).getByRole('button', { name: /^Approve / }))
    const about = within(dialog()).getByTestId('proposal-target')
    expect(about.textContent).toBe(`user ${IDS.user} (reading the user…)`)
    expect(dialog().textContent).toContain(
      'It had not been read then: this question does not say how it is now. Cancel and look at the card to see.'
    )
    await act(() => reading.release())
    await waitFor(() =>
      expect(within(card).getByTestId('proposal-target').textContent).toContain('not banned now')
    )
    expect(within(dialog()).getByTestId('proposal-target').textContent).toBe(
      `user ${IDS.user} (reading the user…)`
    )
  })
})

describe('the audit log', () => {
  test('an approver and an agent whose type or id holds what cannot be seen are written out', async () => {
    const api = installFakeApi()
    api.state.audit = [
      {
        id: 'b1',
        action: 'user.banned',
        actor: { type: 'agent', id: FAKE_AGENT_KEY_ID },
        target: { type: 'user', id: IDS.user },
        ipAddress: null,
        userAgent: null,
        metadata: {
          approvedBy: { type: 'instance\u{200B}_admin', id: 'dash\u{202E}session' },
          proposedBy: 'agent\u{202E}key',
          proposalId: 'p\u{200B}1',
        },
        occurredAt: '2026-10-04T12:00:00.000Z',
      },
    ] as never
    start(`${DEV_PATH}/audit-log`, { api })
    await screen.findByRole('heading', { level: 1, name: 'Audit log' })
    const parties = await screen.findAllByTestId('audit-party')
    expect(parties.map((line) => line.textContent)).toEqual([
      'Approved by instance\\u{200B}_admin dash\\u{202E}session',
      'Asked for by agent agent\\u{202E}key',
      'Carried out proposal p\\u{200B}1',
    ])
    for (const line of parties) {
      expect(line.querySelector('bdi[dir="ltr"]')).not.toBeNull()
    }
  })

  test('a proposal, its approval, the change and the outcome are listed with the agent and the approver', async () => {
    const api = installFakeApi()
    const proposalId = '00000000-0000-7000-8000-00000000aaaa'
    const approvedBy = { type: 'instance_admin', id: 'dash-session-1' }
    const agent = { type: 'agent', id: FAKE_AGENT_KEY_ID }
    const proposal = { type: 'proposal', id: proposalId }
    const about = { operation: 'ban_user', targetType: 'user', targetId: IDS.user }
    const entry = (
      id: string,
      action: string,
      actor: Record<string, unknown>,
      target: Record<string, unknown>,
      metadata: Record<string, unknown>
    ) => ({
      id,
      action,
      actor,
      target,
      ipAddress: null,
      userAgent: null,
      metadata,
      occurredAt: '2026-10-04T12:00:00.000Z',
    })
    api.state.audit = [
      entry('a4', 'proposal.executed', agent, proposal, { ...about, approvedBy, changed: true }),
      entry('a3', 'user.banned', agent, { type: 'user', id: IDS.user }, { proposalId, approvedBy }),
      entry('a2', 'proposal.approved', approvedBy, proposal, {
        ...about,
        proposedBy: FAKE_AGENT_KEY_ID,
      }),
      entry('a1', 'proposal.created', agent, proposal, about),
    ]
    const current = start(`${DEV_PATH}/audit-log`, { api })
    await screen.findByRole('heading', { level: 1, name: 'Audit log' })
    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'proposal.executed',
      'user.banned',
      'proposal.approved',
      'proposal.created',
    ])
    expect(rows.map((row) => within(row).getAllByRole('cell')[2]?.textContent)).toEqual([
      `agent${FAKE_AGENT_KEY_ID}`,
      `agent${FAKE_AGENT_KEY_ID}`,
      'instance_admindash-session-1',
      `agent${FAKE_AGENT_KEY_ID}`,
    ])
    expect(
      rows.map((row) =>
        within(row)
          .queryAllByTestId('audit-party')
          .map((line) => line.textContent)
      )
    ).toEqual([
      ['Approved by instance_admin dash-session-1'],
      ['Approved by instance_admin dash-session-1', `Carried out proposal ${proposalId}`],
      [`Asked for by agent ${FAKE_AGENT_KEY_ID}`],
      [],
    ])
    // The log can be narrowed to what agents did, and to one proposal action.
    await current.user.selectOptions(screen.getByLabelText('Actor type'), 'agent')
    await current.user.selectOptions(screen.getByLabelText('Action'), 'proposal.approved')
    await current.user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => {
      const search = api.callsTo('GET', '/v1/admin/audit-logs').at(-1)?.search
      expect(search?.get('actorType')).toBe('agent')
      expect(search?.get('action')).toBe('proposal.approved')
    })
  })
})
