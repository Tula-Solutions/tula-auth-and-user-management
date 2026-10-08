import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import * as logger from '~/lib/logger'
import { createLogger, REDACTED_KEYS } from '~/lib/logger'

function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)))
      done()
    },
  })
  return { log: createLogger({ level: 'debug', pretty: false }, stream), lines }
}

describe('createLogger', () => {
  test.each([...REDACTED_KEYS])('redacts %s at the top level and one level down', (key) => {
    const { log, lines } = capture()
    log.info({ [key]: 'SECRET', nested: { [key]: 'SECRET' }, safe: 'visible' }, 'msg')
    const [line = {}] = lines
    expect(JSON.stringify(line)).not.toContain('SECRET')
    expect(line[key]).toBe('[redacted]')
    expect(line.safe).toBe('visible')
  })

  test('omits pid and hostname', () => {
    const { log, lines } = capture()
    log.info('hello')
    expect(lines[0]).not.toHaveProperty('pid')
    expect(lines[0]).not.toHaveProperty('hostname')
  })

  test('builds pretty and JSON loggers without a destination', () => {
    expect(createLogger({ level: 'silent', pretty: true }).level).toBe('silent')
    expect(createLogger({ level: 'warn', pretty: false }).level).toBe('warn')
  })
})

describe('module logger', () => {
  test('level functions accept a message with or without context', () => {
    for (const write of [logger.debug, logger.info, logger.warn, logger.error]) {
      expect(() => write('message')).not.toThrow()
      expect(() => write('message', { requestId: 'r1' })).not.toThrow()
    }
  })
})
