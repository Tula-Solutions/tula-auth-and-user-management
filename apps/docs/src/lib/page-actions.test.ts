import { describe, expect, test } from 'bun:test'
import { activeHeading, assistantLinks, MCP_SETUP, menuTarget, promptFor } from './page-actions'

const TWIN = 'https://tula-solutions.github.io/tula-auth-and-user-management/methods/password.md'

describe('the assistant links', () => {
  test('ask to read the page’s Markdown and help, percent-encoded', () => {
    expect(promptFor(TWIN)).toBe(`Read ${TWIN} and help me with it`)
    const encoded = encodeURIComponent(`Read ${TWIN} and help me with it`)
    expect(assistantLinks(TWIN)).toEqual({
      claude: `https://claude.ai/new?q=${encoded}`,
      chatgpt: `https://chatgpt.com/?q=${encoded}`,
      cursor: `https://cursor.com/link/prompt?text=${encoded}`,
    })
  })

  test('decode back to the prompt, whatever the address holds', () => {
    const odd = 'https://x.test/a b/c&d=e#f.md'
    for (const link of Object.values(assistantLinks(odd))) {
      const value = new URL(link).searchParams.get('q') ?? new URL(link).searchParams.get('text')
      expect(value).toBe(`Read ${odd} and help me with it`)
    }
  })
})

describe('MCP_SETUP', () => {
  test('is the documented configuration, with the key left to the reader’s shell', () => {
    const parsed = JSON.parse(MCP_SETUP) as {
      mcpServers: { tula: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.tula.command).toBe('bunx')
    expect(parsed.mcpServers.tula.args).toEqual([
      '--package',
      '@tula-tech/cli@latest',
      'tula',
      'mcp',
    ])
    expect(parsed.mcpServers.tula.env.TULA_AGENT_KEY).toBe('${TULA_AGENT_KEY}')
    expect(MCP_SETUP).not.toMatch(/tula_(ak|sk)_/)
  })
})

describe('activeHeading', () => {
  test('is the last heading whose top has passed the line', () => {
    expect(activeHeading([-500, -100, 40, 300], 80)).toBe(2)
    expect(activeHeading([-500, -100, -20, 300], 80)).toBe(2)
  })

  test('keeps the first entry lit before any heading is reached', () => {
    expect(activeHeading([200, 500], 80)).toBe(0)
  })

  test('is none when there are no headings', () => {
    expect(activeHeading([], 80)).toBe(-1)
  })
})

describe('menuTarget', () => {
  test('moves with the arrow keys and wraps', () => {
    expect(menuTarget('ArrowDown', 0, 5)).toBe(1)
    expect(menuTarget('ArrowDown', 4, 5)).toBe(0)
    expect(menuTarget('ArrowUp', 0, 5)).toBe(4)
    expect(menuTarget('ArrowUp', 3, 5)).toBe(2)
  })

  test('Home and End go to the ends', () => {
    expect(menuTarget('Home', 3, 5)).toBe(0)
    expect(menuTarget('End', 1, 5)).toBe(4)
  })

  test('other keys are not the menu’s', () => {
    expect(menuTarget('a', 1, 5)).toBeUndefined()
    expect(menuTarget('Tab', 1, 5)).toBeUndefined()
  })
})
