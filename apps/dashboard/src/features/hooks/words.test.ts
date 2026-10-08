import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_FAILURE_MODES,
  HOOK_FAILURE_REASONS,
  HOOK_POINTS,
  hookWeakenings,
} from '@tula/contract'
import { ApiError } from '~/api/errors'
import { entryImports } from '~/testing/entry-imports'
import { deadlineOf, hookProblems, serverProblems } from './hook-form'
import { pointsOf } from './hooks-screen'
import {
  failureModeText,
  failureOutcome,
  failureReasonText,
  hookMessageFor,
  hookState,
  pointWords,
  strengthOf,
  weakeningSentences,
} from './words'

function refusal(status: number, code: string, params: Record<string, unknown> = {}): ApiError {
  return new ApiError({ status, code, detail: 'The server’s own words.', params })
}

describe('a point in words', () => {
  test('every point the contract defines has words of its own, each different', () => {
    const words = HOOK_POINTS.map(pointWords)
    for (const field of ['label', 'asked', 'allowing', 'gone'] as const) {
      expect(new Set(words.map((entry) => entry[field])).size).toBe(HOOK_POINTS.length)
    }
    // The claims point cannot deny, and says so instead of "allows or denies".
    expect(pointWords('before_token').asked).toContain('it cannot deny')
    expect(pointWords('before_sign_up').asked).toContain('allows the sign-up or denies it')
  })

  test('a point this version does not know is named as it is, with general words', () => {
    expect(pointWords('before_refresh')).toEqual({
      label: 'before_refresh',
      asked: 'A point this version of the dashboard does not know.',
      allowing:
        'When a call of this hook fails, what it was asked about goes ahead, as if there were no hook.',
      gone: 'It is no longer asked: what it was asked about goes ahead, as if there were no hook.',
    })
  })
})

describe('a weakening in words', () => {
  const on = { enabled: true, failureMode: 'deny' } as const
  // Every change of the two fields, and a registration and a removal: the sentences are one
  // per field the contract's rule names, so the screen never asks by a rule of its own.
  const states = [
    null,
    on,
    { enabled: true, failureMode: 'allow' },
    { enabled: false, failureMode: 'deny' },
    { enabled: false, failureMode: 'allow' },
  ] as const

  test('one sentence per field `hookWeakenings` names, for every change', () => {
    for (const point of HOOK_POINTS) {
      const words = pointWords(point)
      for (const was of states) {
        for (const is of states) {
          expect(weakeningSentences(point, was, is)).toEqual(
            hookWeakenings(was, is).map((field) =>
              field === 'enabled' ? words.gone : words.allowing
            )
          )
        }
      }
    }
  })

  test.each([
    ['adding one that refuses on failure', null, on, 0],
    ['adding one that lets through', null, { enabled: true, failureMode: 'allow' }, 1],
    ['switching one off', on, { enabled: false, failureMode: 'deny' }, 1],
    ['removing one that is on', on, null, 1],
    ['removing one that is off', { enabled: false, failureMode: 'deny' }, null, 0],
    ['switching one on', { enabled: false, failureMode: 'deny' }, on, 0],
    ['back to refusing', { enabled: true, failureMode: 'allow' }, on, 0],
  ] as const)('%s', (_name, was, is, sentences) => {
    expect(weakeningSentences('before_session', was, is)).toHaveLength(sentences)
  })

  test('a failure mode this version does not know is read as refusing, so “allow” is still asked about', () => {
    expect(strengthOf({ enabled: true, failureMode: 'retry' })).toEqual({
      enabled: true,
      failureMode: 'deny',
    })
    expect(strengthOf({ enabled: false, failureMode: 'allow' })).toEqual({
      enabled: false,
      failureMode: 'allow',
    })
  })
})

describe('a hook’s state and its last failed call in words', () => {
  test('on, on and letting through, and off are three states', () => {
    const hook = { point: 'before_sign_up', enabled: true, failureMode: 'deny' }
    expect(hookState(hook).kind).toBe('on')
    expect(hookState({ ...hook, failureMode: 'allow' })).toEqual({
      kind: 'on-allowing',
      label: 'On, letting through on failure',
      detail: pointWords('before_sign_up').allowing,
    })
    expect(hookState({ ...hook, enabled: false, failureMode: 'allow' }).kind).toBe('off')
  })

  test('every failure mode and every failure reason of the contract has words that are not the fallback', () => {
    for (const mode of HOOK_FAILURE_MODES) {
      expect(failureModeText(mode)).not.toBe(mode)
      expect(failureModeText(mode)).toContain(`(${mode})`)
    }
    expect(failureModeText('retry')).toBe('retry')
    const sentences = HOOK_FAILURE_REASONS.map(failureReasonText)
    expect(sentences.filter((sentence) => sentence.startsWith('The server gave'))).toEqual([])
    expect(new Set(sentences).size).toBe(HOOK_FAILURE_REASONS.length)
    expect(failureReasonText('quota_spent')).toBe('The server gave this reason: quota_spent')
  })

  test('only “no answer in time” is a time-out; nothing recorded is neither', () => {
    expect(failureOutcome({ lastFailedAt: null, lastFailureReason: null })).toBe('none')
    for (const reason of HOOK_FAILURE_REASONS) {
      expect(
        failureOutcome({ lastFailedAt: '2026-10-03T09:00:00.000Z', lastFailureReason: reason })
      ).toBe(reason === 'timeout' ? 'timed-out' : 'failed')
    }
  })
})

describe('a refusal in words', () => {
  test('a conflict means one thing when adding and another when changing', () => {
    const conflict = refusal(409, 'resource.conflict')
    expect(hookMessageFor(conflict, 'create')).toStartWith('This point already has one')
    expect(hookMessageFor(conflict, 'change')).toStartWith('It was changed elsewhere')
    expect(hookMessageFor(conflict)).toStartWith('It was changed elsewhere')
  })

  test('a hook that is gone says so when it was being changed, and only then', () => {
    const gone = refusal(404, 'resource.not_found')
    expect(hookMessageFor(gone, 'change')).toStartWith('It no longer exists')
    expect(hookMessageFor(gone, 'create')).not.toStartWith('It no longer exists')
  })

  test('a code this screen has no words for is what every other screen says, never the bare code', () => {
    const sentence = hookMessageFor(refusal(418, 'teapot.short_and_stout'))
    expect(sentence).not.toContain('teapot')
    expect(sentence.length).toBeGreaterThan(10)
  })

  test('the guard’s refusal goes on the address, a field error on its field, the rest on the form', () => {
    const guard = refusal(422, 'hook.url_not_allowed', { reason: 'scheme_not_allowed' })
    expect(serverProblems(guard, 'create')).toEqual({
      url: 'The address must start with https://.',
      deadlineMs: undefined,
      failureMode: undefined,
    })
    const field = new ApiError({
      status: 422,
      code: 'validation.failed',
      detail: 'The request is not valid.',
      fieldErrors: [{ field: 'deadlineMs', code: 'validation.failed', message: 'Too large.' }],
    })
    expect(serverProblems(field, 'change').deadlineMs).toBe('Too large.')
    expect(serverProblems(refusal(409, 'resource.conflict'), 'create')).toEqual({
      general: hookMessageFor(refusal(409, 'resource.conflict'), 'create'),
    })
    expect(serverProblems(null, 'create')).toEqual({})
  })
})

describe('the form’s own reading of what was typed', () => {
  test.each([
    ['2000', 2000],
    [' 100 ', 100],
    ['', Number.NaN],
    ['1.5e3', Number.NaN],
    ['-200', Number.NaN],
    ['2000ms', Number.NaN],
    ['0x10', Number.NaN],
  ])('a deadline typed as %j is %d', (typed, value) => {
    expect(deadlineOf(typed)).toBe(value)
  })

  test('each issue of a failed parse is said on its field, the first of each', () => {
    expect(
      hookProblems(
        [
          { path: ['url'], code: 'too_big', message: 'Too long.' },
          { path: ['url'], message: 'Second.' },
          { path: ['failureMode'], message: 'Invalid option.' },
          { path: ['point'], message: 'Invalid option.' },
        ],
        'https://a.example'
      )
    ).toEqual({
      url: 'Use 2048 characters or fewer.',
      failureMode: 'Choose what happens when a call fails.',
      general: 'Invalid option.',
    })
  })
})

describe('the cards of the list', () => {
  const hook = (id: string, point: string) => ({
    id,
    point,
    url: 'https://a.example',
    enabled: true,
    deadlineMs: 2000,
    failureMode: 'deny',
    lastFailedAt: null,
    lastFailureReason: null,
    createdAt: '2026-10-04T12:00:00.000Z',
    updatedAt: '2026-10-04T12:00:00.000Z',
  })

  test('the contract’s points first and always, then whatever else the server lists, each once', () => {
    const list = [
      hook('4', 'before_refresh'),
      hook('2', 'before_token'),
      hook('3', 'before_token'),
      hook('1', 'before_sign_up'),
    ]
    expect(pointsOf(list).map((entry) => [entry.key, entry.point, entry.hook?.id ?? null])).toEqual(
      [
        ['before_sign_up', 'before_sign_up', '1'],
        ['before_session', 'before_session', null],
        ['before_token', 'before_token', '2'],
        ['4', 'before_refresh', '4'],
        ['3', 'before_token', '3'],
      ]
    )
  })
})

describe('what the route file runs before its screen is loaded stays free of Zod', () => {
  const SRC = join(import.meta.dir, '../..')
  const ROUTE = join(SRC, 'routes/_app/w.$workspaceId/p.$projectId/e.$environmentId/hooks.tsx')

  test('the route names a screen and reaches no schema; the screen does, so the walk would see it', () => {
    const route = entryImports(ROUTE, SRC)
    expect(route.lazy.length).toBe(1)
    expect(route.forbidden).toEqual([])
    const screen = join(SRC, 'features/hooks/hooks-screen.tsx')
    expect(entryImports(screen, SRC, { everything: true }).forbidden).toContain('@tula/contract')
  })
})

describe('the vocabulary', () => {
  // A hook is a question whose answer decides what happens next; a webhook is a notice of
  // something that has happened (GLOSSARY.md). The screen is about the first, and says so.
  const HERE = import.meta.dir

  test('the hooks screen never says “webhook” or “callback”', () => {
    const files = readdirSync(HERE)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .map((name) => join(HERE, name))
    // A walk that finds no file proves nothing.
    expect(files.length).toBe(7)
    const offending = files.filter((file) =>
      /webhook|callback/i.test(
        readFileSync(file, 'utf8')
          // What is shared with the other feature is imported from it by path, and the
          // contract's cap on an address carries its first user's name. Neither is said.
          .replaceAll('~/features/webhooks/', '')
          .replaceAll('MAX_WEBHOOK_URL_LENGTH', '')
      )
    )
    expect(offending).toEqual([])
  })
})
