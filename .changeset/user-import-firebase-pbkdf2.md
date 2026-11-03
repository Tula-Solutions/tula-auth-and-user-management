---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
---

User import takes two more password hash formats. `pbkdf2_sha256` (Django's `pbkdf2_sha256$…`, PHC and passlib `$pbkdf2-sha256$…` strings, or a base64 derived key with `params` `{ iterations, salt }`; 100,000 to 2,000,000 iterations) and `firebase_scrypt` (Firebase's `passwordHash`, with the user's `salt` in `params`). The Firebase project's hash parameters go once per call in the new `firebaseScrypt` field of `ImportUsersRequest` (`FirebaseScryptParamsSchema`: `signerKey`, `saltSeparator`, `rounds`, `memCost`); the server seals them and never returns them. The `user.imported` event's `passwordAlgorithm` also takes `pbkdf2_sha256` and `firebase_scrypt`. The first sign-in replaces either hash with argon2id.
