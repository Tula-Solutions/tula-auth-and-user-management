import { createTulaClient, memoryStorage } from '@tula/core'
import { sdkJourneys } from '~/testing/sdk-journeys'

// `@tula/core`'s suite: the journeys of `~/testing/sdk-journeys`, for the client itself. It
// can be every kind of client, so every journey is declared; `core`'s column of
// `conformance/client-journeys.json` says which scenarios those cover, and the guard inside
// the journeys fails when the two disagree.
sdkJourneys({
  client: 'core',
  // Not a browser and no particular device: tokens in the answer's body, kept where it is told.
  native: 'server',
  create: createTulaClient,
  storage: memoryStorage,
  browser: true,
  oauth: true,
  passkeys: true,
  deviceKey: true,
  // Every kind of client, so nothing waits for a feature.
  notBuilt: {},
  sources: [import.meta.path],
})
