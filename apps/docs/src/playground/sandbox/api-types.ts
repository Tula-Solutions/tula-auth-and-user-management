import type { Operations } from '~core-api'

// The client API's generated types, from the one place that writes them. `@tula-tech/core`
// does not export its generated file, and a docs app must not edit a publishable package for
// its own sake, so the path is an alias (`tsconfig.json`, `vite.config.ts`). Every handler of
// the sandbox is typed with these: an operation added to the API fails the typecheck here
// until the sandbox answers it, so the sandbox cannot drift from the contract silently.
export type { Operations, Schemas } from '~core-api'
export { OPERATIONS } from '~core-api'

/** The id of a client operation, as the OpenAPI document names it. */
export type OperationId = keyof Operations
