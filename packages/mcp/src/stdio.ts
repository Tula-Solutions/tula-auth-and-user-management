import type { Readable, Writable } from 'node:stream'
import type { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

/**
 * The streams a server is served on, and how it learns that the process is being stopped.
 *
 * @example
 * ```ts
 * const streams: StdioStreams = {
 *   input: process.stdin,
 *   output: process.stdout,
 *   onTerminate: (stop) => {
 *     process.once('SIGTERM', stop)
 *     return () => process.off('SIGTERM', stop)
 *   },
 * }
 * ```
 */
export interface StdioStreams {
  /** Where the client's messages arrive: standard input. */
  input: Readable
  /** Where the server's messages go: standard output. Nothing else may be written to it. */
  output: Writable
  /** Call `stop` when the process is asked to end (SIGTERM, SIGINT). Returns how to stop listening. */
  onTerminate?: (stop: () => void) => () => void
}

/**
 * Serve an MCP server over a pair of streams, newline-delimited JSON-RPC, until the client
 * closes the input or the process is asked to stop; then close the server.
 *
 * Only protocol messages are written to `output`. Anything else a process wants to say goes
 * to standard error: one stray line on standard output breaks the client's parser.
 *
 * @param server - The server, not yet connected.
 * @param streams - The streams and the stop signal.
 * @returns When the server has been closed.
 *
 * @example
 * ```ts
 * await serveOverStdio(createTulaMcpServer({ cwd }), { input: process.stdin, output: process.stdout })
 * ```
 */
export async function serveOverStdio(server: McpServer, streams: StdioStreams): Promise<void> {
  const transport = new StdioServerTransport(streams.input, streams.output)
  let stopListening: (() => void) | undefined
  const ended = new Promise<void>((resolve) => {
    streams.input.once('end', resolve)
    streams.input.once('close', resolve)
    stopListening = streams.onTerminate?.(resolve)
  })
  await server.connect(transport)
  await ended
  stopListening?.()
  await server.close()
}
