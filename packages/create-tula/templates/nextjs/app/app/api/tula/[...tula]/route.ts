import { createTulaHandlers } from '@tula/nextjs/handlers'

// The browser's Tula client talks to this route on the app's own origin; the handler forwards
// to the API's /v1/client/* and keeps the session cookies first-party.
export const { GET, POST, PUT, PATCH, DELETE } = createTulaHandlers()
