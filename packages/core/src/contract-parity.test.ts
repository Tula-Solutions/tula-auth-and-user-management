import { describe, expect, test } from 'bun:test'
import type * as Contract from '@tula/contract'
import {
  CLIENT_HEADER,
  FLOW_ATTEMPT_HEADER,
  PUBLISHABLE_KEY_HEADER,
  PUBLISHABLE_KEY_PREFIX,
  SECRET_KEY_PREFIX,
} from '@tula/contract'
import { createTulaClient } from './client'
import type { Schemas } from './generated/api.gen'
import { OPERATIONS } from './generated/api.gen'
import type * as Core from './index'
import { evaluatePassword } from './index'

/** Compiles only when `A` and `B` are assignable to each other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// The SDK's public types come from the OpenAPI snapshot, so that its declarations do not
// depend on Zod. These lines fail to compile if they ever stop matching the contract's own
// types: `bun run typecheck` is the test.
const parity: {
  flowStep: Same<Core.FlowStep, Contract.FlowStep>
  flowKind: Same<Core.FlowKind, Contract.FlowKind>
  firstFactor: Same<Core.FirstFactorStrategy, Contract.FirstFactorStrategy>
  secondFactor: Same<Core.SecondFactorMethod, Contract.SecondFactorMethod>
  user: Same<Core.User, Contract.User>
  session: Same<Core.Session, Contract.Session>
  clientKind: Same<Core.ClientKind, Contract.SessionClient>
  passwordPolicy: Same<Core.PasswordPolicy, Contract.PasswordPolicy>
  clientConfig: Same<Core.ClientConfig, Contract.ClientConfig>
  tokens: Same<Schemas['SessionTokens'], Contract.SessionTokens>
  attempt: Same<Schemas['FlowAttempt'], Contract.FlowAttempt>
  errorCode: Same<Schemas['ErrorCode'], Contract.ErrorCode>
  envelope: Same<Schemas['ErrorEnvelope'], Contract.ErrorEnvelope>
} = {
  flowStep: true,
  flowKind: true,
  firstFactor: true,
  secondFactor: true,
  user: true,
  session: true,
  clientKind: true,
  passwordPolicy: true,
  clientConfig: true,
  tokens: true,
  attempt: true,
  errorCode: true,
  envelope: true,
}

describe('parity with @tula/contract', () => {
  test('the generated types match the contract’s (checked by the compiler)', () => {
    expect(Object.values(parity).every(Boolean)).toBe(true)
  })

  test('the key prefixes repeated in the client are the contract’s', () => {
    const options = { baseUrl: 'https://auth.test' }
    expect(() =>
      createTulaClient({ ...options, publishableKey: `${PUBLISHABLE_KEY_PREFIX}x` })
    ).not.toThrow()
    expect(() => createTulaClient({ ...options, publishableKey: `${SECRET_KEY_PREFIX}x` })).toThrow(
      /secret key/
    )
  })

  test('the header names the client sends are the contract’s', () => {
    expect([PUBLISHABLE_KEY_HEADER, CLIENT_HEADER, FLOW_ATTEMPT_HEADER]).toEqual([
      'x-tula-publishable-key',
      'x-tula-client',
      'x-tula-attempt',
    ])
  })

  test('every generated operation is a client route', () => {
    for (const route of Object.values(OPERATIONS)) {
      expect(route.path.startsWith('/v1/client/')).toBe(true)
    }
    expect(Object.keys(OPERATIONS)).toHaveLength(22)
  })

  test('evaluatePassword is the contract’s rule engine and accepts the generated policy type', () => {
    const policy: Core.PasswordPolicy = {
      preset: 'recommended',
      minLength: 10,
      maxLength: 128,
      requireLowercase: false,
      requireUppercase: false,
      requireNumber: false,
      requireSpecial: false,
      minCharacterClasses: 0,
      specialChars: '!',
      disallowUserInfo: true,
      disallowCommon: true,
      breachCheck: 'block',
      maxRepeatedChars: null,
      blockSequences: false,
      history: 0,
      expiryDays: null,
    }
    expect(evaluatePassword(policy, 'short').ok).toBe(false)
    expect(evaluatePassword(policy, 'correct horse battery').ok).toBe(true)
  })
})
