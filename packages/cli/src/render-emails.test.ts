import { describe, expect, test } from 'bun:test'
import { defineConfig } from '@tula/config'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import { buildPlan, type Plan } from './diff'
import { createOutput } from './output'
import { renderPlan } from './render'

// What an operator reads about email templates in a plan (ADR 0039). A template's text is
// shown like every other string setting (`app.name` is), cut at the same length; the
// server's copy is somebody else's text, so nothing a reader cannot see is printed.

function plan(file: Record<string, unknown>, server: Record<string, unknown>): Plan {
  const environment = defineConfig({
    environments: { dev: { settings: { emails: { templates: file } } as never } },
  }).environments.dev
  if (!environment) {
    throw new Error('fixture')
  }
  const settings: EnvironmentSettings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  settings.emails.templates = server as never
  return buildPlan(
    { revision: 1, settings, managedBy: null, providers: [], webhooks: [] },
    environment,
    { configHash: `sha256:${'0'.repeat(64)}`, prune: false }
  )
}

function rendered(result: Plan): string {
  let text = ''
  const sink = { write: (chunk: string) => (text += chunk) }
  renderPlan(
    createOutput(sink, sink, {}),
    { environment: 'dev', apiUrl: 'https://a.example' },
    result
  )
  return text
}

describe('a plan’s words about email templates', () => {
  test('a changed subject is one line that names the kind and the field', () => {
    const text = rendered(
      plan(
        { email_verification: { subject: 'Code {{code}}' } },
        { email_verification: { subject: '{{code}} is your code' } }
      )
    )
    expect(text).toContain(
      '  ~ emails.templates.email_verification.subject: "{{code}} is your code" → "Code {{code}}"'
    )
  })

  test('a template the file leaves out is removed, and the line says what is sent instead', () => {
    const text = rendered(plan({}, { password_changed: { body: 'Your password changed.' } }))
    expect(text).toContain(
      '  - emails.templates.password_changed.body: "Your password changed." (the built-in copy is sent)'
    )
    expect(text).not.toContain('does not know')
  })

  test('a long body is cut like any other value', () => {
    const body = `Your code: {{code}} ${'word '.repeat(300)}`
    const text = rendered(plan({ email_verification: { body } }, {}))
    const line = text.split('\n').find((entry) => entry.includes('email_verification.body')) ?? ''
    expect(line).toContain('"Your code: {{code}} word')
    expect(line.endsWith('…')).toBe(true)
    expect(line.length).toBeLessThan(160)
  })

  test('the server’s text is printed without what a reader cannot see', () => {
    const text = rendered(
      plan(
        {},
        { password_changed: { subject: 'Changed\u001b[2J\u{202E}now\u{200B}', body: 'A\nB' } }
      )
    )
    expect(text).toContain('emails.templates.password_changed.subject: "Changed [2Jnow"')
    expect(text).toContain('emails.templates.password_changed.body: "A B"')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u{202E}')
    expect(text).not.toContain('\u{200B}')
  })
})
