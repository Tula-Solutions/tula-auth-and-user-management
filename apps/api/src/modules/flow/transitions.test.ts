import { describe, expect, test } from 'bun:test'
import {
  type FirstFactorStrategy,
  type FlowKind,
  FlowKindSchema,
  type FlowStatus,
  FlowStepSchema,
} from '@tula/contract'
import { ServiceException } from '~/exceptions'
import {
  assertAccepts,
  FLOW_EVENT_TYPES,
  type FlowContext,
  type FlowEvent,
  type FlowEventType,
  nextStatus,
} from '~/modules/flow/transitions'

const KINDS: readonly FlowKind[] = FlowKindSchema.options
const STATUSES: readonly FlowStatus[] = FlowStepSchema.options.map(
  (option) => option.shape.status.value
)

/**
 * Events to try, by name. Typed by event type, so adding a type to `FLOW_EVENT_TYPES` without a
 * sample here does not compile.
 */
const EVENTS = {
  password: { type: 'first_factor_verified', strategy: 'password' },
  email_code: { type: 'first_factor_verified', strategy: 'email_code' },
  email_link: { type: 'first_factor_verified', strategy: 'email_link' },
  email_verified: { type: 'email_verified' },
  password_reset: { type: 'password_reset' },
  second_factor: { type: 'second_factor_verified' },
} as const satisfies Record<string, FlowEvent>
type EventName = keyof typeof EVENTS

const SAMPLED: Record<FlowEventType, readonly EventName[]> = {
  first_factor_verified: ['password', 'email_code', 'email_link'],
  email_verified: ['email_verified'],
  password_reset: ['password_reset'],
  second_factor_verified: ['second_factor'],
}

/** The strategies an attempt was offered. */
const OFFERS = {
  none: [],
  P: ['password'],
  PE: ['password', 'email_code'],
  E: ['email_code'],
  PEL: ['password', 'email_code', 'email_link'],
  EL: ['email_code', 'email_link'],
} as const satisfies Record<string, readonly FirstFactorStrategy[]>
type OfferName = keyof typeof OFFERS

/** What is known about the user: email verified (V) or not (U), with (2) or without (0) a second factor. */
const USERS = {
  V0: { emailVerified: true, secondFactors: [] },
  V2: { emailVerified: true, secondFactors: ['totp'] },
  U0: { emailVerified: false, secondFactors: [] },
  U2: { emailVerified: false, secondFactors: ['totp', 'backup_code'] },
} as const satisfies Record<string, Omit<FlowContext, 'strategies'>>
type UserName = keyof typeof USERS

const ANY_OFFER = Object.keys(OFFERS) as OfferName[]
const ANY_USER = Object.keys(USERS) as UserName[]

/**
 * Every allowed transition. Whatever is not listed here must be refused: the test below walks
 * the whole cross product and asserts one or the other for each combination.
 */
const ALLOWED: readonly [FlowKind, FlowStatus, EventName, OfferName[], UserName[], FlowStatus][] = [
  // Sign-up: the account is created when the email is verified; nothing about a user matters.
  ['sign_up', 'needs_email_verification', 'email_verified', ANY_OFFER, ANY_USER, 'complete'],

  // Sign-in on the password step accepts only the password.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, ['V0'], 'complete'],
  ['sign_in', 'needs_password', 'password', ANY_OFFER, ['V2'], 'needs_second_factor'],
  // An unverified email comes before the second factor.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, ['U0', 'U2'], 'needs_email_verification'],

  // Sign-in with a choice accepts exactly the strategies the attempt was offered.
  ['sign_in', 'needs_first_factor', 'password', ['P', 'PE', 'PEL'], ['V0'], 'complete'],
  ['sign_in', 'needs_first_factor', 'password', ['P', 'PE', 'PEL'], ['V2'], 'needs_second_factor'],
  [
    'sign_in',
    'needs_first_factor',
    'password',
    ['P', 'PE', 'PEL'],
    ['U0', 'U2'],
    'needs_email_verification',
  ],
  ['sign_in', 'needs_first_factor', 'email_code', ['PE', 'E', 'PEL', 'EL'], ['V0'], 'complete'],
  [
    'sign_in',
    'needs_first_factor',
    'email_code',
    ['PE', 'E', 'PEL', 'EL'],
    ['V2'],
    'needs_second_factor',
  ],
  // The function is asked with `emailVerified: true` after an email factor (the email is the
  // proof), so the engine never takes these two rows; the table still has to classify them.
  [
    'sign_in',
    'needs_first_factor',
    'email_code',
    ['PE', 'E', 'PEL', 'EL'],
    ['U0', 'U2'],
    'needs_email_verification',
  ],
  // An emailed link is a first factor like the code, where the attempt was offered it.
  ['sign_in', 'needs_first_factor', 'email_link', ['PEL', 'EL'], ['V0'], 'complete'],
  ['sign_in', 'needs_first_factor', 'email_link', ['PEL', 'EL'], ['V2'], 'needs_second_factor'],
  [
    'sign_in',
    'needs_first_factor',
    'email_link',
    ['PEL', 'EL'],
    ['U0', 'U2'],
    'needs_email_verification',
  ],

  // After the email is verified, the second factor if there is one.
  ['sign_in', 'needs_email_verification', 'email_verified', ANY_OFFER, ['V0', 'U0'], 'complete'],
  [
    'sign_in',
    'needs_email_verification',
    'email_verified',
    ANY_OFFER,
    ['V2', 'U2'],
    'needs_second_factor',
  ],
  ['sign_in', 'needs_second_factor', 'second_factor', ANY_OFFER, ANY_USER, 'complete'],

  // A reset: an inbox alone does not bypass the second factor.
  ['password_reset', 'needs_new_password', 'password_reset', ANY_OFFER, ['V0', 'U0'], 'complete'],
  [
    'password_reset',
    'needs_new_password',
    'password_reset',
    ANY_OFFER,
    ['V2', 'U2'],
    'needs_second_factor',
  ],
  ['password_reset', 'needs_second_factor', 'second_factor', ANY_OFFER, ANY_USER, 'complete'],
]

function expected(
  kind: FlowKind,
  status: FlowStatus,
  event: EventName,
  offer: OfferName,
  user: UserName
): FlowStatus | 'refused' {
  const rows = ALLOWED.filter(
    ([k, s, e, offers, users]) =>
      k === kind && s === status && e === event && offers.includes(offer) && users.includes(user)
  )
  if (rows.length > 1) {
    throw new Error(`two rows classify ${kind} ${status} ${event} ${offer} ${user}`)
  }
  return rows[0]?.[5] ?? 'refused'
}

function outcome(
  kind: FlowKind,
  status: FlowStatus,
  event: FlowEvent,
  context: FlowContext
): FlowStatus | 'refused' {
  try {
    return nextStatus(kind, status, event, context)
  } catch (err) {
    if (err instanceof ServiceException && err.code === 'flow.invalid_step' && err.status === 409) {
      return 'refused'
    }
    throw err
  }
}

describe('nextStatus', () => {
  const combinations: [FlowKind, FlowStatus, EventName][] = KINDS.flatMap((kind) =>
    STATUSES.flatMap((status) =>
      FLOW_EVENT_TYPES.flatMap((type) =>
        SAMPLED[type].map((event): [FlowKind, FlowStatus, EventName] => [kind, status, event])
      )
    )
  )

  test('the table covers every kind, every step and every event type', () => {
    expect(KINDS).toEqual(['sign_in', 'sign_up', 'password_reset'])
    expect(STATUSES).toEqual([
      'needs_identifier',
      'needs_password',
      'needs_first_factor',
      'needs_email_verification',
      'needs_new_password',
      'needs_second_factor',
      'complete',
    ])
    expect(combinations).toHaveLength(KINDS.length * STATUSES.length * 6)
  })

  // One test per kind × step × event; each asserts every offer and every kind of user.
  test.each(combinations)('%s on %s + %s', (kind, status, event) => {
    for (const offer of ANY_OFFER) {
      for (const user of ANY_USER) {
        const actual = outcome(kind, status, EVENTS[event], {
          strategies: OFFERS[offer],
          ...USERS[user],
        })
        expect({ offer, user, result: actual }).toEqual({
          offer,
          user,
          result: expected(kind, status, event, offer, user),
        })
      }
    }
  })

  test('every allowed row is reachable in the cross product', () => {
    for (const [kind, status, event] of ALLOWED) {
      expect(combinations).toContainEqual([kind, status, event])
    }
  })

  test('nothing follows a completed attempt, and nothing starts from a step no flow issues', () => {
    for (const status of ['complete', 'needs_identifier'] as const) {
      expect(ALLOWED.some(([, from]) => from === status)).toBe(false)
    }
  })

  test('no path reaches `complete` past a required second factor without proving it', () => {
    for (const [, , event, , users, to] of ALLOWED) {
      if (to === 'complete' && event !== 'second_factor' && event !== 'email_verified') {
        expect(users.some((user) => USERS[user].secondFactors.length > 0)).toBe(false)
      }
    }
    // The one exception is a sign-up, whose account is created at that moment.
    expect(
      ALLOWED.filter(
        ([kind, , event, , users, to]) =>
          to === 'complete' &&
          event === 'email_verified' &&
          users.some((user) => USERS[user].secondFactors.length > 0) &&
          kind !== 'sign_up'
      )
    ).toEqual([])
  })
})

describe('assertAccepts', () => {
  test('passes for an event the step accepts, whatever the user turns out to be', () => {
    expect(() =>
      assertAccepts('sign_in', 'needs_email_verification', EVENTS.email_verified)
    ).not.toThrow()
    expect(() => assertAccepts('sign_in', 'needs_password', EVENTS.password)).not.toThrow()
    expect(() =>
      assertAccepts('sign_in', 'needs_first_factor', EVENTS.password, ['password', 'email_code'])
    ).not.toThrow()
  })

  test('refuses what the table refuses', () => {
    for (const refuse of [
      () => assertAccepts('sign_in', 'needs_password', EVENTS.email_verified),
      () => assertAccepts('sign_in', 'needs_first_factor', EVENTS.password),
      () => assertAccepts('sign_in', 'needs_first_factor', EVENTS.password, ['email_code']),
      () => assertAccepts('sign_up', 'needs_second_factor', EVENTS.second_factor),
    ]) {
      expect(refuse).toThrow(ServiceException)
    }
  })
})
