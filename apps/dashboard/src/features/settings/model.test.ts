import { describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { ApiError } from '~/api/errors'
import {
  classifyFailure,
  confirmationTitle,
  describeWeakening,
  etag,
  planSave,
  type SettingsDocument,
} from './model'

const base = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS) as SettingsDocument

function edited(change: (draft: typeof DEFAULT_ENVIRONMENT_SETTINGS) => void): SettingsDocument {
  const draft = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  change(draft)
  return draft as SettingsDocument
}

describe('etag', () => {
  test('quotes the revision, as If-Match wants it', () => {
    expect(etag(0)).toBe('"0"')
    expect(etag(12)).toBe('"12"')
  })
})

describe('planSave', () => {
  test('an unchanged document is not dirty and needs no confirmation', () => {
    const plan = planSave(base, structuredClone(base), null)
    expect(plan).toEqual({
      dirty: false,
      weakenings: [],
      managedBy: null,
      needsConfirmation: false,
    })
  })

  test('a stricter policy is saved without asking', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.password.minLength += 4
      }),
      null
    )
    expect(plan.dirty).toBe(true)
    expect(plan.weakenings).toEqual([])
    expect(plan.needsConfirmation).toBe(false)
  })

  test('a shorter minimum length is a weakening, by the contract’s definition', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.password.minLength = 8
      }),
      null
    )
    expect(plan.weakenings).toEqual(['password.minLength'])
    expect(plan.needsConfirmation).toBe(true)
  })

  test('switching two-step verification off and a notice off are both listed', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.mfa.policy = 'off'
        draft.notifications.newSignIn = false
      }),
      null
    )
    expect(plan.weakenings).toEqual(['notifications.newSignIn', 'mfa.policy'])
  })

  test('settings managed by a config file ask before any change', () => {
    const managedBy = { tool: 'tula-apply', drifted: false }
    const plan = planSave(
      base,
      edited((draft) => {
        draft.app.name = 'Acme'
      }),
      managedBy
    )
    expect(plan.weakenings).toEqual([])
    expect(plan.managedBy).toBe('tula-apply')
    expect(plan.needsConfirmation).toBe(true)
  })

  test('a draft the contract cannot read lists no weakening (the server will refuse it)', () => {
    const broken = { ...base, password: { ...base.password, minLength: 'eight' } }
    const plan = planSave(base, broken as unknown as SettingsDocument, null)
    expect(plan.dirty).toBe(true)
    expect(plan.weakenings).toEqual([])
  })
})

describe('an audit retention period', () => {
  const withPeriod = (retentionDays: number | null): SettingsDocument =>
    ({ ...structuredClone(DEFAULT_ENVIRONMENT_SETTINGS), audit: { retentionDays } }) as never

  test.each([
    ['set where there was none', null, 30, true],
    ['shortened', 365, 30, true],
    ['lengthened', 30, 365, false],
    ['removed', 30, null, false],
  ] as [string, number | null, number | null, boolean][])(
    '%s asks first: %p to %p is %p',
    (_name, was, is, asks) => {
      const plan = planSave(withPeriod(was), withPeriod(is), null)
      expect(plan.weakenings).toEqual(asks ? ['audit.retentionDays'] : [])
      expect(plan.needsConfirmation).toBe(asks)
    }
  )

  test('is described as what it is: a deletion that cannot be undone', () => {
    expect(describeWeakening('audit.retentionDays')).toBe(
      'Audit entries older than the new period are deleted for good, within ten minutes'
    )
    expect(confirmationTitle(['audit.retentionDays'])).toBe(
      'This deletes older audit entries for good. Save anyway?'
    )
    expect(confirmationTitle(['mfa.policy', 'audit.retentionDays'])).toBe(
      'This weakens security and deletes older audit entries for good. Save anyway?'
    )
    expect(confirmationTitle(['mfa.policy'])).toBe('This weakens security. Save anyway?')
    expect(confirmationTitle([])).toBe('Change settings managed by a config file?')
  })
})

describe('describeWeakening', () => {
  test('says a known path in words and keeps an unknown one', () => {
    expect(describeWeakening('password.minLength')).toContain('shorter')
    expect(describeWeakening('sessions.profiles.admin')).toContain('admin')
    expect(describeWeakening('future.setting')).toBe('future.setting')
  })
})

describe('classifyFailure', () => {
  test('412 is a conflict: the settings changed elsewhere', () => {
    const error = new ApiError({ status: 412, code: 'precondition.failed', detail: 'Stale.' })
    expect(classifyFailure(error)).toBe('conflict')
  })
  test('field errors are a refused document', () => {
    const error = new ApiError({
      status: 422,
      code: 'validation.failed',
      detail: 'Invalid.',
      fieldErrors: [{ field: 'signIn.methods', code: 'validation.failed', message: 'x' }],
    })
    expect(classifyFailure(error)).toBe('invalid')
  })
  test('anything else just failed', () => {
    expect(classifyFailure(new Error('boom'))).toBe('failed')
  })
})
