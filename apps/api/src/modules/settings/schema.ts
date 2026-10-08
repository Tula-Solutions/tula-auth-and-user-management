import { EnvironmentSettingsSchema, SettingsManagedBySchema } from '@tula/contract'
import { z } from 'zod'

/** The document and the client view are owned by the contract, so SDKs and the CLI share them. */
export {
  ClientConfigSchema,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
} from '@tula/contract'

// The document as it is in effect. The two lists are plain strings here: at revision 0
// `urls.allowedOrigins` is the deployment's `CORS_ORIGINS` as written, which is not validated
// at boot and can hold an entry a `PUT` would refuse. Showing it is the point (it is what the
// environment allows), so answering must not depend on it being storable.
const ReturnedSettings = EnvironmentSettingsSchema.safeExtend({
  urls: z.strictObject({
    allowedOrigins: z.array(z.string()),
    allowedRedirectUrls: z.array(z.string()),
  }),
})

/**
 * An environment's settings as the admin API returns them.
 *
 * `revision` is 0 for an environment that has saved nothing yet (its `settings` are then the
 * deployment's defaults) and grows by one with every change. Send it back as
 * `If-Match: "<revision>"` to replace the settings.
 *
 * `managedBy` says which tool applies these settings from a config file, if one does, and
 * whether they have been changed around it since (`drifted`); `null` when nobody manages them
 * (ADR 0030).
 */
export const EnvironmentSettingsStateSchema = z
  .object({
    revision: z.number().int().min(0),
    settings: ReturnedSettings,
    managedBy: SettingsManagedBySchema.nullable(),
  })
  .meta({ ref: 'EnvironmentSettingsState' })

/** An environment's settings and their revision. */
export type EnvironmentSettingsState = z.infer<typeof EnvironmentSettingsStateSchema>
