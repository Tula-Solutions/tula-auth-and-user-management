import CryptoKit
import Foundation

/// The hash of a set of permission keys, in the form an access token's `perms_hash` claim carries.
///
/// The keys are deduplicated, ordered by UTF-16 code unit (as `@tula-tech/contract`'s
/// `permissionsHash` does, so the two agree for any input), written as a JSON array with no
/// spaces and hashed with SHA-256: `1.` and the digest in unpadded base64url. The shared
/// vectors in `packages/contract/src/permissions-hash-vectors.json` hold the two to each other.
///
/// - Parameter keys: The permission keys; order and repeats do not matter.
/// - Returns: The versioned hash, for example `1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU` for no keys.
public func permissionsHash(_ keys: [String]) -> String {
    let sorted = Set(keys).sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    let items = sorted.map { key -> String in
        var out = "\""
        for scalar in key.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
    let json = "[" + items.joined(separator: ",") + "]"
    let digest = Data(SHA256.hash(data: Data(json.utf8)))
    let encoded = digest.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "1." + encoded
}
