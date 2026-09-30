import { z } from 'zod'

/** Signing-key lifecycle state. */
export const SigningKeyStatusSchema = z
  .enum(['next', 'active', 'retired'])
  .meta({ ref: 'SigningKeyStatus' })

/** A signing key as shown to admins. Private material is never returned. */
export const SigningKeySchema = z
  .object({
    /** The JWT `kid`. */
    id: z.uuid(),
    status: SigningKeyStatusSchema,
    createdAt: z.date(),
    activatedAt: z.date().nullable(),
    retiredAt: z.date().nullable(),
  })
  .meta({ ref: 'SigningKey' })

/** An environment's signing keys, newest first. */
export const SigningKeyListSchema = z
  .object({ data: z.array(SigningKeySchema) })
  .meta({ ref: 'SigningKeyList' })

/** Path parameters naming an environment. */
export const EnvironmentIdParamSchema = z.object({ environmentId: z.uuid() })

/** A signing key (admin view). */
export type SigningKey = z.infer<typeof SigningKeySchema>
