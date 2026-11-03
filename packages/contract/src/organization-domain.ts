import { z } from 'zod'
import {
  domainRefusal,
  MAX_DOMAIN_LENGTH,
  ORGANIZATION_DOMAIN_MODES,
  ORGANIZATION_DOMAIN_STATUSES,
} from './organization-domain-rules'

// Verified domains of an organization and the suggestions built from them (ADR 0065,
// "Verified domains"). The grammar, the public list and the modes are in
// `./organization-domain-rules` (no Zod); this module is the schemas built from them.

/**
 * A domain an organization can claim: see {@link DOMAIN_PATTERN}. The grammar and the length
 * bounds are checked here; that the domain is not a **public** mail domain is a rule the
 * server answers with its own code (`organization.domain_public`), because it is a refusal of
 * a well-formed claim.
 */
export const OrganizationDomainNameSchema = z
  .string()
  .max(2 * MAX_DOMAIN_LENGTH)
  .superRefine((domain, context) => {
    const refusal = domainRefusal(domain)
    if (refusal === 'grammar') {
      context.addIssue({
        code: 'custom',
        message:
          'a domain is lower-case ASCII letters, digits and hyphens in labels joined by full stops (write an internationalised name in punycode)',
      })
    } else if (refusal === 'length') {
      context.addIssue({
        code: 'custom',
        message: 'a domain is at most 253 characters, and each label at most 63',
      })
    }
  })
  .meta({ ref: 'OrganizationDomainName' })

/** How an organization treats a user with a verified address on its domain. */
export const OrganizationDomainModeSchema = z
  .enum(ORGANIZATION_DOMAIN_MODES)
  .meta({ ref: 'OrganizationDomainMode' })

/** What a domain row is now: see {@link OrganizationDomainSchema}. */
export const OrganizationDomainStatusSchema = z
  .enum(ORGANIZATION_DOMAIN_STATUSES)
  .meta({ ref: 'OrganizationDomainStatus' })

/**
 * A domain of an organization. **Pending** (`status` `pending`, `verifiedAt` is `null`): a
 * code was emailed and not yet entered; it grants nothing. **Verified**: a user who signs up
 * with a verified address on it is suggested the organization or joined to it, by `mode`,
 * until `expiresAt`. **Needs re-verification**: `expiresAt` has passed; the domain matches
 * nobody until a manager claims it again and enters the new code (ADR 0065, "Lapse").
 */
export const OrganizationDomainSchema = z
  .object({
    id: z.string(),
    domain: z.string(),
    mode: OrganizationDomainModeSchema,
    status: OrganizationDomainStatusSchema,
    /** When the code was last entered; `null` while the claim is pending. */
    verifiedAt: z.iso.datetime().nullable(),
    /** When the verification lapses; `null` while the claim is pending. */
    expiresAt: z.iso.datetime().nullable(),
    /**
     * When the emailed code stops working; `null` when no code is waiting. A verified domain
     * has one while a manager is proving it again.
     */
    codeExpiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'OrganizationDomain' })

/** An organization's domains, oldest first. */
export const OrganizationDomainListSchema = z
  .object({ data: z.array(OrganizationDomainSchema) })
  .meta({ ref: 'OrganizationDomainList' })

/**
 * Claim a domain: email a code to an address **on that domain**, and say what a verified
 * domain does. Sent again for a pending claim it emails a new code (the old one stops
 * working) and may change `mode`. Sent for a verified domain of the same organization it
 * starts a re-verification: the domain keeps working, with its mode, until the new code is
 * entered (which restarts its lifetime) or it lapses.
 */
export const StartOrganizationDomainRequestSchema = z
  .strictObject({
    domain: OrganizationDomainNameSchema,
    /** An address on `domain`; the code is sent there. */
    email: z.string().max(320),
    mode: OrganizationDomainModeSchema,
  })
  .meta({ ref: 'StartOrganizationDomainRequest' })

/** The code that verifies a claimed domain. */
export const VerifyOrganizationDomainRequestSchema = z
  .strictObject({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'VerifyOrganizationDomainRequest' })

/** Change what a domain does. */
export const UpdateOrganizationDomainRequestSchema = z
  .strictObject({ mode: OrganizationDomainModeSchema })
  .meta({ ref: 'UpdateOrganizationDomainRequest' })

/**
 * An organization the signed-in user can join because of a verified address on its verified
 * domain. Its name and slug only: the user is told nothing of its members.
 */
export const OrganizationSuggestionSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ ref: 'OrganizationSuggestion' })

/** The organizations the signed-in user is suggested, none of which they belong to. */
export const OrganizationSuggestionListSchema = z
  .object({ data: z.array(OrganizationSuggestionSchema) })
  .meta({ ref: 'OrganizationSuggestionList' })

/** A domain of an organization. */
export type OrganizationDomain = z.infer<typeof OrganizationDomainSchema>
/** An organization's domains. */
export type OrganizationDomainList = z.infer<typeof OrganizationDomainListSchema>
/** The body that claims a domain. */
export type StartOrganizationDomainRequest = z.infer<typeof StartOrganizationDomainRequestSchema>
/** The body that verifies a claimed domain. */
export type VerifyOrganizationDomainRequest = z.infer<typeof VerifyOrganizationDomainRequestSchema>
/** The body that changes a domain's mode. */
export type UpdateOrganizationDomainRequest = z.infer<typeof UpdateOrganizationDomainRequestSchema>
/** An organization the user can join. */
export type OrganizationSuggestion = z.infer<typeof OrganizationSuggestionSchema>
/** The user's suggestions. */
export type OrganizationSuggestionList = z.infer<typeof OrganizationSuggestionListSchema>
