import { describe, expect, test } from 'bun:test'
import { lastUpdated, type Run, runGit } from './git'

describe('runGit', () => {
  test('runs git in the directory and reports success and output', () => {
    const result = runGit(import.meta.dir)(['--version'])
    expect(result.ok).toBe(true)
    expect(result.out).toContain('git version')
  })

  test('reports a failure, with no output, for a command git refuses', () => {
    expect(runGit(import.meta.dir)(['no-such-command'])).toEqual({ ok: false, out: '' })
  })
})

describe('lastUpdated', () => {
  test('is the commit date of the file in a full clone', () => {
    const run: Run = (args) =>
      args[0] === 'rev-parse' ? { ok: true, out: 'false' } : { ok: true, out: '2026-10-20' }
    expect(lastUpdated(run)('docs/a.md')).toBe('2026-10-20')
  })

  test('is nothing for any file in a shallow clone, where every date would be the same wrong one', () => {
    const run: Run = (args) =>
      args[0] === 'rev-parse' ? { ok: true, out: 'true' } : { ok: true, out: '2026-10-20' }
    expect(lastUpdated(run)('docs/a.md')).toBeUndefined()
  })

  test('is nothing where git is missing or the directory is not a repository', () => {
    expect(lastUpdated(() => ({ ok: false, out: '' }))('docs/a.md')).toBeUndefined()
  })

  test('is nothing for a file git has no commit for, or an answer that is not a date', () => {
    const run: Run = (args) =>
      args[0] === 'rev-parse' ? { ok: true, out: 'false' } : { ok: true, out: '' }
    expect(lastUpdated(run)('docs/new.md')).toBeUndefined()
  })
})
