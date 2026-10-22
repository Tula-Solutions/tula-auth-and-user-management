import { describe, expect, test } from 'bun:test'
import { checkSource, importsOf } from './checks'

const rules = (source: string) => checkSource(source).map((refusal) => refusal.rule)

/** One fixture per forbidden pattern: each must be refused, under its own rule. */
describe('the build refuses', () => {
  test('an import of @tula-tech/core', () => {
    expect(
      rules(`import { createTulaClient } from '@tula-tech/core'\nexport const x = 1`)
    ).toContain('imports-core')
  })

  test('a call to client.session.signOut()', () => {
    const source = `import { useTulaClient } from '@tula-tech/react'
export function Out() {
  const client = useTulaClient()
  return <button type='button' onClick={() => client.session.signOut()} />
}`
    expect(rules(source)).toContain('client-sign-out')
  })

  test('window read during render', () => {
    const source = `export function Where() {
  const here = window.location.href
  return <a href={here} />
}`
    expect(rules(source)).toContain('global-in-render')
  })

  test('document read during render', () => {
    expect(
      rules(`export function T() {\n  const t = document.title\n  return <i data-t={t} />\n}`)
    ).toContain('global-in-render')
  })

  test('localStorage read during render', () => {
    expect(
      rules(
        `export function T() {\n  const t = localStorage.getItem('a')\n  return <i data-t={t} />\n}`
      )
    ).toContain('global-in-render')
  })

  test('dangerouslySetInnerHTML', () => {
    expect(
      rules(
        `export function H(p: { h: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: p.h }} />\n}`
      )
    ).toContain('inner-html')
  })

  test('console', () => {
    expect(rules(`export function C() {\n  console.log('x')\n  return null\n}`)).toContain(
      'console'
    )
  })

  test('a hard-coded string in JSX text', () => {
    expect(rules(`export function S() {\n  return <p>Welcome back</p>\n}`)).toContain(
      'hard-coded-string'
    )
  })

  test('a hard-coded string in a visible attribute', () => {
    expect(
      rules(`export function S() {\n  return <input placeholder='Your email' />\n}`)
    ).toContain('hard-coded-string')
    expect(rules(`export function S() {\n  return <button aria-label='Close' />\n}`)).toContain(
      'hard-coded-string'
    )
  })

  test('a hard-coded string in a JSX expression', () => {
    expect(
      rules(`export function S(p: { a: boolean }) {\n  return <p>{p.a ? 'Yes' : 'No'}</p>\n}`)
    ).toContain('hard-coded-string')
  })

  test('an import that is not on the list', () => {
    expect(rules(`import _ from 'lodash'\nexport const x = _`)).toContain('import-not-allowed')
  })
})

describe('the build allows', () => {
  test('browser globals inside effects and handlers', () => {
    const source = `import { useEffect } from 'react'
export function Ok() {
  useEffect(() => {
    document.title = 'x'.length.toString()
  }, [])
  return <button type='button' onClick={() => window.scrollTo(0, 0)} />
}`
    expect(rules(source)).toEqual([])
  })

  test('class names, ids and symbols as strings', () => {
    expect(
      rules(`export function Ok() {\n  return <div className='flex' id='a' role='group' />\n}`)
    ).toEqual([])
  })

  test('the allowed imports', () => {
    const source = `import { useId } from 'react'
import { useLocalization } from '@tula-tech/react'
import { Button } from '@/components/ui/button'
import { StepCard } from '@/components/tula/step-card'
import { cn } from '@/lib/utils'
export const x = [useId, useLocalization, Button, StepCard, cn]`
    expect(rules(source)).toEqual([])
    expect(importsOf(source)).toEqual([
      'react',
      '@tula-tech/react',
      '@/components/ui/button',
      '@/components/tula/step-card',
      '@/lib/utils',
    ])
  })
})
