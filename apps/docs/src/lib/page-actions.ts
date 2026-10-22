/**
 * What the page-actions menu opens, and the two small rules the page script applies (which
 * heading is current, where focus goes in the menu), kept here so that they are tested without
 * a browser.
 */

/**
 * The prompt an assistant is given.
 *
 * @param markdownUrl - The absolute address of the page's Markdown twin.
 * @returns One sentence naming it.
 */
export function promptFor(markdownUrl: string): string {
  return `Read ${markdownUrl} and help me with it`
}

/** The three assistants a page can be opened in. */
export interface AssistantLinks {
  claude: string
  chatgpt: string
  cursor: string
}

/**
 * The addresses that open an assistant with a page already asked about.
 *
 * - Claude: `https://claude.ai/new?q=`. Not in Anthropic's documentation; it is the address
 *   shadcn/ui's "Open in Claude" uses.
 * - ChatGPT: `https://chatgpt.com/?q=`. Not in OpenAI's documentation either; shadcn/ui's.
 * - Cursor: `https://cursor.com/link/prompt?text=`, documented at
 *   https://cursor.com/docs/integrations/deeplinks. The `cursor://anysphere.cursor-deeplink/prompt`
 *   form does nothing in a browser without the app; the web form hands over to it.
 *
 * @param markdownUrl - The absolute address of the page's Markdown twin.
 * @returns One address for each, the prompt percent-encoded.
 */
export function assistantLinks(markdownUrl: string): AssistantLinks {
  const prompt = encodeURIComponent(promptFor(markdownUrl))
  return {
    claude: `https://claude.ai/new?q=${prompt}`,
    chatgpt: `https://chatgpt.com/?q=${prompt}`,
    cursor: `https://cursor.com/link/prompt?text=${prompt}`,
  }
}

/**
 * The configuration an MCP client takes for `tula mcp`: the `.mcp.json` of `docs/mcp.md`
 * ("Claude Code"). The key is a placeholder the reader's shell fills, never a value.
 */
export const MCP_SETUP = `{
  "mcpServers": {
    "tula": {
      "command": "bunx",
      "args": ["--package", "@tula-tech/cli@latest", "tula", "mcp"],
      "env": {
        "TULA_API_URL": "http://localhost:3003",
        "TULA_AGENT_KEY": "\${TULA_AGENT_KEY}"
      }
    }
  }
}
`

/**
 * Which heading a reader is in: the last one whose top has passed the line under the header.
 *
 * @param tops - Each heading's distance from the viewport's top, in document order.
 * @param line - The distance below which a heading has not been reached yet.
 * @returns The index; `0` before the first heading is reached (the first entry stays lit from
 *   the top of the page); `-1` when there are no headings.
 */
export function activeHeading(tops: readonly number[], line: number): number {
  let active = tops.length === 0 ? -1 : 0
  for (const [index, top] of tops.entries()) {
    if (top <= line) {
      active = index
    }
  }
  return active
}

/**
 * Where focus goes in a menu for a key.
 *
 * @param key - A `KeyboardEvent.key`.
 * @param current - The focused item's index, or `-1` for none.
 * @param count - The number of items.
 * @returns The index to focus, or `undefined` for a key the menu does not use.
 */
export function menuTarget(key: string, current: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}
