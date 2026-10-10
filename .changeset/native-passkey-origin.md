---
'@tula/contract': minor
---

`androidApkKeyHashOrigin(fingerprint)` and `ANDROID_APK_KEY_HASH_PREFIX`: the origin an
Android app's passkey response carries (`android:apk-key-hash:` and the SHA-256 fingerprint
of its signing certificate as base64url without padding), from a fingerprint in either
spelling; `null` for a value that is not one. The API accepts a passkey response from a
registered native app by that origin (Android) or by `https://<rpId>` (iOS, once an iOS app
is registered), for a request with no `Origin` that says `x-tula-client: ios` or `android`.
