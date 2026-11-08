package dev.tula.auth

import java.security.MessageDigest
import java.util.Base64

/**
 * The hash of a set of permission keys, in the form an access token's `perms_hash` claim carries.
 *
 * The keys are deduplicated, ordered by UTF-16 code unit (Kotlin's `String` order, which is also
 * what `@tula-tech/contract`'s `permissionsHash` sorts by), written as a JSON array with no
 * spaces and hashed with SHA-256: `1.` and the digest in unpadded base64url. The shared vectors
 * in `packages/contract/src/permissions-hash-vectors.json` hold the two to each other.
 *
 * @param keys The permission keys; order and repeats do not matter.
 * @return The versioned hash, for example `1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU` for no keys.
 */
fun permissionsHash(keys: List<String>): String {
    val json = keys.toSortedSet().joinToString(",", "[", "]") { key ->
        buildString {
            append('"')
            for (c in key) {
                when {
                    c == '"' -> append("\\\"")
                    c == '\\' -> append("\\\\")
                    c == '\b' -> append("\\b")
                    c == '\u000C' -> append("\\f")
                    c == '\n' -> append("\\n")
                    c == '\r' -> append("\\r")
                    c == '\t' -> append("\\t")
                    c < ' ' -> append("\\u%04x".format(c.code))
                    else -> append(c)
                }
            }
            append('"')
        }
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8))
    return "1." + Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
}
