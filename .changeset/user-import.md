---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/core": minor
---

Bulk user import. `POST /v1/admin/users/import` (`importUsers` in `@tula-tech/admin`) takes up to 500 users per call, each with an email, `emailVerified`, an optional name, metadata and external id, and an optional password hash in the tagged form `{ algorithm, hash, params? }` (`bcrypt`, `argon2id`, `argon2i`). The answer reports every row as `created`, `skipped` (the address exists, or repeats in the call) or `refused` with a contract error code. The contract gains `ImportUsersRequestSchema`, `ImportUsersResultSchema` and the row schemas, `MAX_IMPORT_ROWS`, the error codes `import.unsupported_algorithm`, `import.hash_malformed`, `import.hash_parameters_too_weak`, `import.hash_parameters_too_costly`, and the activity type `user.imported` (its data holds booleans and the closed `passwordAlgorithm` only), so an import does not fire `user.created`. `@tula-tech/core` gets the new error codes and event type in its generated types.
