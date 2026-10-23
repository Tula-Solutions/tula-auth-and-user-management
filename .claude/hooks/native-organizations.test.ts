import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ORGANIZATION_CLAIMS_BYTES,
  MAX_ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ID_CLAIM,
  ORGANIZATION_PERMISSIONS_CLAIM,
  ORGANIZATION_ROLE_CLAIM,
} from '../../packages/contract/src/custom-claims'
import { ORGANIZATION_INVITATION_TOKEN_PARAM } from '../../packages/contract/src/headers'
import { MAX_PERMISSION_KEY_LENGTH } from '../../packages/contract/src/organization-permissions'

// The Swift and Kotlin clients read the active organization from the access token and an
// invitation's token from the emailed link, by hand-written copies of the contract's names and
// caps (ADR 0065, TULA-121). Nothing generated holds the copies to the contract, and the
// clients' own tests would still pass if both sides drifted the same way; this test reads the
// sources and holds each constant to the contract's, so a changed claim name, fragment
// parameter or cap fails here until the native clients follow.

const ROOT = join(import.meta.dir, '..', '..')
const SWIFT = readFileSync(
  join(ROOT, 'native/swift/Sources/TulaAuth/TulaOrganizations.swift'),
  'utf8'
)
const KOTLIN = readFileSync(
  join(ROOT, 'native/android/tula-auth/src/main/kotlin/dev/tula/auth/Organizations.kt'),
  'utf8'
)

describe('the native clients keep the contract organization names and caps', () => {
  test.each([
    ['the id claim', ORGANIZATION_ID_CLAIM, /idClaim = "([^"]+)"/, /ID_CLAIM = "([^"]+)"/],
    ['the role claim', ORGANIZATION_ROLE_CLAIM, /roleClaim = "([^"]+)"/, /ROLE_CLAIM = "([^"]+)"/],
    [
      'the permissions claim',
      ORGANIZATION_PERMISSIONS_CLAIM,
      /permissionsClaim = "([^"]+)"/,
      /PERMISSIONS_CLAIM = "([^"]+)"/,
    ],
    [
      'the fragment parameter of an invitation link',
      ORGANIZATION_INVITATION_TOKEN_PARAM,
      /fragmentParameter = "([^"]+)"/,
      /FRAGMENT_PARAMETER = "([^"]+)"/,
    ],
  ])('%s', (_name, expected, swift, kotlin) => {
    expect(SWIFT.match(swift)?.[1]).toBe(expected)
    expect(KOTLIN.match(kotlin)?.[1]).toBe(expected)
  })

  test.each([
    [
      'the most permissions',
      MAX_ORGANIZATION_PERMISSIONS_CLAIM,
      /maxPermissions = (\d+)/,
      /MAX_PERMISSIONS = (\d+)/,
    ],
    [
      'the longest permission key',
      MAX_PERMISSION_KEY_LENGTH,
      /maxPermissionKeyLength = (\d+)/,
      /MAX_PERMISSION_KEY_LENGTH = (\d+)/,
    ],
    [
      'the byte cap of the claims',
      MAX_ORGANIZATION_CLAIMS_BYTES,
      /maxBytes = (\d+)/,
      /MAX_BYTES = (\d+)/,
    ],
  ])('%s', (_name, expected, swift, kotlin) => {
    expect(Number(SWIFT.match(swift)?.[1])).toBe(expected)
    expect(Number(KOTLIN.match(kotlin)?.[1])).toBe(expected)
  })
})
