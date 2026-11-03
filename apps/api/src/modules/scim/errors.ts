import type { ErrorCode } from '@tula-tech/contract'
import { ServiceException } from '~/exceptions'

/** The `scimType` values RFC 7644 section 3.12 defines that this server answers. */
export type ScimType = 'uniqueness' | 'invalidFilter' | 'invalidValue' | 'invalidSyntax'

/**
 * An error whose SCIM answer carries a `scimType`. It is still a contract exception (code,
 * status), so a log line and a test read it like any other; only the router's handler turns
 * it into the SCIM envelope.
 */
export class ScimError extends ServiceException {
  /** What the identity provider reads to tell the cause apart. */
  readonly scimType: ScimType

  /**
   * @param code - The contract code that fixes the status.
   * @param scimType - The SCIM error type.
   * @param message - The detail the identity provider's administrator reads.
   */
  constructor(code: ErrorCode, scimType: ScimType, message: string) {
    super(code, { message })
    this.name = 'ScimError'
    this.scimType = scimType
  }
}

/** 409 `uniqueness`: a user with this `userName` or `externalId` exists in the directory. */
export const uniqueness = () =>
  new ScimError(
    'resource.conflict',
    'uniqueness',
    'A user with this userName or externalId exists.'
  )

/** 400 `invalidValue`. */
export const invalidValue = (message: string) =>
  new ScimError('request.malformed', 'invalidValue', message)
