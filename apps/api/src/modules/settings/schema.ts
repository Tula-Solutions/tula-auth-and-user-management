import { EnvironmentSettingsSchema } from '@tula/contract'
import { z } from 'zod'

/** The document and the client view are owned by the contract, so SDKs and the CLI share them. */
export { ClientConfigSchema, EnvironmentSettingsSchema } from '@tula/contract'

/**
 * An environment's settings as the admin API returns them.
 *
 * `revision` is 0 for an environment that has saved nothing yet (its `settings` are then the
 * deployment's defaults) and grows by one with every change. Send it back as
 * `If-Match: "<revision>"` to replace the settings.
 */
export const EnvironmentSettingsStateSchema = z
  .object({
    revision: z.number().int().min(0),
    settings: EnvironmentSettingsSchema,
  })
  .meta({ ref: 'EnvironmentSettingsState' })

/** An environment's settings and their revision. */
export type EnvironmentSettingsState = z.infer<typeof EnvironmentSettingsStateSchema>
