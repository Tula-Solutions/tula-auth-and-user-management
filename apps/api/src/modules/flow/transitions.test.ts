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
  enrolled: { type: 'factor_enrolled' },
  renewed: { type: 'expired_password_replaced' },
} as const satisfies Record<string, FlowEvent>
type EventName = keyof typeof EVENTS

const SAMPLED: Record<FlowEventType, readonly EventName[]> = {
  first_factor_verified: ['password', 'email_code', 'email_link'],
  email_verified: ['email_verified'],
  password_reset: ['password_reset'],
  second_factor_verified: ['second_factor'],
  factor_enrolled: ['enrolled'],
  expired_password_replaced: ['renewed'],
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

/**
 * What is known about the user: email verified (V) or not (U); with a second factor (2),
 * without one (0), or without one in an environment that requires one (E: must enrol); and,
 * with a trailing X, that the password the attempt proved has expired (ADR 0041).
 */
const FRESH_USERS = {
  V0: { emailVerified: true, secondFactors: [], enrolmentRequired: false },
  V2: { emailVerified: true, secondFactors: ['totp'], enrolmentRequired: false },
  VE: { emailVerified: true, secondFactors: [], enrolmentRequired: true },
  U0: { emailVerified: false, secondFactors: [], enrolmentRequired: false },
  U2: { emailVerified: false, secondFactors: ['totp', 'backup_code'], enrolmentRequired: false },
  UE: { emailVerified: false, secondFactors: [], enrolmentRequired: true },
} as const satisfies Record<string, Omit<FlowContext, 'strategies' | 'passwordExpired'>>
type FreshName = keyof typeof FRESH_USERS
type UserName = FreshName | `${FreshName}X`

const FRESH = Object.keys(FRESH_USERS) as FreshName[]
/** The same users, holding a password that has expired. */
const EXPIRED = FRESH.map((name): UserName => `${name}X`)
const USERS = Object.fromEntries([
  ...FRESH.map((name) => [name, { ...FRESH_USERS[name], passwordExpired: false }]),
  ...FRESH.map((name) => [`${name}X`, { ...FRESH_USERS[name], passwordExpired: true }]),
]) as Record<UserName, Omit<FlowContext, 'strategies'>>

/** Each of `names` with a fresh password and with an expired one: where expiry changes nothing. */
const either = (names: FreshName[]): UserName[] =>
  names.flatMap((name): UserName[] => [name, `${name}X`])

const ANY_OFFER = Object.keys(OFFERS) as OfferName[]
const ANY_USER: UserName[] = [...FRESH, ...EXPIRED]
/** Users with an unverified email: the address is verified before anything about factors. */
const UNVERIFIED = either(['U0', 'U2', 'UE'])
const ENROL = 'needs_factor_enrolment'
const RENEW = 'needs_new_password'

/**
 * Every allowed transition. Whatever is not listed here must be refused: the test below walks
 * the whole cross product and asserts one or the other for each combination.
 */
const ALLOWED: readonly [FlowKind, FlowStatus, EventName, OfferName[], UserName[], FlowStatus][] = [
  // Sign-up: the account is created when the email is verified, so it has no factor to ask for;
  // where the environment requires one it must enrol before completing. A sign-up's password
  // is new: "expired" changes nothing about it.
  [
    'sign_up',
    'needs_email_verification',
    'email_verified',
    ANY_OFFER,
    either(['V0', 'V2', 'U0', 'U2']),
    'complete',
  ],
  ['sign_up', 'needs_email_verification', 'email_verified', ANY_OFFER, either(['VE', 'UE']), ENROL],

  // Sign-in on the password step accepts only the password.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, ['V0'], 'complete'],
  // An expired password that is right asks for a new one, and creates no session.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, ['V0X'], RENEW],
  // The second factor, or the enrolment, comes before the new password.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, either(['V2']), 'needs_second_factor'],
  ['sign_in', 'needs_password', 'password', ANY_OFFER, either(['VE']), ENROL],
  // An unverified email comes before the second factor.
  ['sign_in', 'needs_password', 'password', ANY_OFFER, UNVERIFIED, 'needs_email_verification'],

  // Sign-in with a choice accepts exactly the strategies the attempt was offered.
  ['sign_in', 'needs_first_factor', 'password', ['P', 'PE', 'PEL'], ['V0'], 'complete'],
  ['sign_in', 'needs_first_factor', 'password', ['P', 'PE', 'PEL'], ['V0X'], RENEW],
  [
    'sign_in',
    'needs_first_factor',
    'password',
    ['P', 'PE', 'PEL'],
    either(['V2']),
    'needs_second_factor',
  ],
  ['sign_in', 'needs_first_factor', 'password', ['P', 'PE', 'PEL'], either(['VE']), ENROL],
  [
    'sign_in',
    'needs_first_factor',
    'password',
    ['P', 'PE', 'PEL'],
    UNVERIFIED,
    'needs_email_verification',
  ],
  // Another first factor never stops for the password's age: nobody typed the password.
  [
    'sign_in',
    'needs_first_factor',
    'email_code',
    ['PE', 'E', 'PEL', 'EL'],
    either(['V0']),
    'complete',
  ],
  [
    'sign_in',
    'needs_first_factor',
    'email_code',
    ['PE', 'E', 'PEL', 'EL'],
    either(['V2']),
    'needs_second_factor',
  ],
  ['sign_in', 'needs_first_factor', 'email_code', ['PE', 'E', 'PEL', 'EL'], either(['VE']), ENROL],
  // The function is asked with `emailVerified: true` after an email factor (the email is the
  // proof), so the engine never takes these two rows; the table still has to classify them.
  [
    'sign_in',
    'needs_first_factor',
    'email_code',
    ['PE', 'E', 'PEL', 'EL'],
    UNVERIFIED,
    'needs_email_verification',
  ],
  // An emailed link is a first factor like the code, where the attempt was offered it.
  ['sign_in', 'needs_first_factor', 'email_link', ['PEL', 'EL'], either(['V0']), 'complete'],
  [
    'sign_in',
    'needs_first_factor',
    'email_link',
    ['PEL', 'EL'],
    either(['V2']),
    'needs_second_factor',
  ],
  ['sign_in', 'needs_first_factor', 'email_link', ['PEL', 'EL'], either(['VE']), ENROL],
  [
    'sign_in',
    'needs_first_factor',
    'email_link',
    ['PEL', 'EL'],
    UNVERIFIED,
    'needs_email_verification',
  ],

  // After the email is verified, the second factor if there is one; then the new password.
  ['sign_in', 'needs_email_verification', 'email_verified', ANY_OFFER, ['V0', 'U0'], 'complete'],
  ['sign_in', 'needs_email_verification', 'email_verified', ANY_OFFER, ['V0X', 'U0X'], RENEW],
  [
    'sign_in',
    'needs_email_verification',
    'email_verified',
    ANY_OFFER,
    either(['V2', 'U2']),
    'needs_second_factor',
  ],
  ['sign_in', 'needs_email_verification', 'email_verified', ANY_OFFER, either(['VE', 'UE']), ENROL],
  ['sign_in', 'needs_second_factor', 'second_factor', ANY_OFFER, FRESH, 'complete'],
  // A proven second factor does not excuse an expired password: it is asked for next.
  ['sign_in', 'needs_second_factor', 'second_factor', ANY_OFFER, EXPIRED, RENEW],
  // The one way out of the step, for a sign-in: the password was replaced.
  ['sign_in', RENEW, 'renewed', ANY_OFFER, ANY_USER, 'complete'],

  // A reset: an inbox alone does not bypass the second factor. Its password is new.
  [
    'password_reset',
    'needs_new_password',
    'password_reset',
    ANY_OFFER,
    either(['V0', 'U0']),
    'complete',
  ],
  [
    'password_reset',
    'needs_new_password',
    'password_reset',
    ANY_OFFER,
    either(['V2', 'U2']),
    'needs_second_factor',
  ],
  [
    'password_reset',
    'needs_new_password',
    'password_reset',
    ANY_OFFER,
    either(['VE', 'UE']),
    ENROL,
  ],
  ['password_reset', 'needs_second_factor', 'second_factor', ANY_OFFER, ANY_USER, 'complete'],

  // Where the environment requires a second factor, enrolling one is what completes an attempt
  // of any kind, unless it is a sign-in that still owes a new password.
  ['sign_in', ENROL, 'enrolled', ANY_OFFER, FRESH, 'complete'],
  ['sign_in', ENROL, 'enrolled', ANY_OFFER, EXPIRED, RENEW],
  ['sign_up', ENROL, 'enrolled', ANY_OFFER, ANY_USER, 'complete'],
  ['password_reset', ENROL, 'enrolled', ANY_OFFER, ANY_USER, 'complete'],
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
      'needs_factor_enrolment',
      'complete',
    ])
    expect(combinations).toHaveLength(KINDS.length * STATUSES.length * 8)
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
      if (
        to === 'complete' &&
        event !== 'second_factor' &&
        event !== 'email_verified' &&
        event !== 'enrolled' &&
        // Replacing an expired password is the last thing a sign-in does: see the tests below.
        event !== 'renewed'
      ) {
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

  test('no path reaches `complete` for a user who must enrol, except by enrolling', () => {
    for (const [, from, event, , users, to] of ALLOWED) {
      if (
        to === 'complete' &&
        event !== 'enrolled' &&
        from !== 'needs_second_factor' &&
        from !== RENEW
      ) {
        expect(users.some((user) => USERS[user].enrolmentRequired)).toBe(false)
      }
    }
    // Enrolment is only ever accepted on its own step.
    expect(ALLOWED.filter(([, from, event]) => event === 'enrolled' && from !== ENROL)).toEqual([])
    expect(ALLOWED.filter(([, from, event]) => from === ENROL && event !== 'enrolled')).toEqual([])
  })
})

describe('an expired password (ADR 0041)', () => {
  const signIns = ALLOWED.filter(([kind]) => kind === 'sign_in')

  test('a sign-in that proved one completes only by replacing it', () => {
    for (const [, , event, , users, to] of signIns) {
      if (to === 'complete' && users.some((user) => USERS[user].passwordExpired)) {
        // The password was replaced, or it was never typed.
        expect(['renewed', 'email_code', 'email_link']).toContain(event)
      }
    }
  })

  test('the new password is asked for only once no factor is owed any more', () => {
    for (const [, from, event, , users, to] of ALLOWED) {
      if (to !== RENEW) {
        continue
      }
      expect(users.every((user) => USERS[user].passwordExpired)).toBe(true)
      if (event === 'second_factor' || event === 'enrolled') {
        expect(['needs_second_factor', ENROL]).toContain(from)
      } else {
        // Reached straight from a first factor or the emailed code: nothing else was owed.
        expect(
          users.some(
            (user) => USERS[user].secondFactors.length > 0 || USERS[user].enrolmentRequired
          )
        ).toBe(false)
      }
    }
  })

  test('only a sign-in is ever sent to it, and only a replaced password leaves it', () => {
    expect(ALLOWED.filter(([kind, , , , , to]) => to === RENEW && kind !== 'sign_in')).toEqual([])
    expect(signIns.filter(([, from, event]) => from === RENEW && event !== 'renewed')).toEqual([])
    expect(ALLOWED.filter(([, from, event]) => event === 'renewed' && from !== RENEW)).toEqual([])
    // A reset's own step is left by the reset and by nothing else.
    expect(
      ALLOWED.filter(([kind, from]) => kind === 'password_reset' && from === RENEW).map(
        ([, , event]) => event
      )
    ).toEqual(['password_reset', 'password_reset', 'password_reset'])
  })

  test('a password that has not expired is never asked to be replaced', () => {
    for (const [, , , , users, to] of ALLOWED) {
      if (to === RENEW) {
        expect(users.filter((user) => !USERS[user].passwordExpired)).toEqual([])
      }
    }
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
      () => assertAccepts('sign_in', 'needs_second_factor', EVENTS.enrolled),
      () => assertAccepts('sign_in', 'needs_factor_enrolment', EVENTS.second_factor),
      // A reset's step does not take a sign-in's new password, nor a sign-in's a reset.
      () => assertAccepts('password_reset', 'needs_new_password', EVENTS.renewed),
      () => assertAccepts('sign_in', 'needs_new_password', EVENTS.password_reset),
      () => assertAccepts('sign_in', 'needs_second_factor', EVENTS.renewed),
    ]) {
      expect(refuse).toThrow(ServiceException)
    }
  })
})
