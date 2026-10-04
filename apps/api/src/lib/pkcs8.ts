const PEM = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/

/**
 * Read the bytes of a PKCS#8 private key from its PEM text (the contents of Apple's `.p8` file).
 *
 * @param pem - `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----`.
 * @returns The DER bytes.
 * @throws Error when the text is not an unencrypted PKCS#8 PEM. The message never quotes it.
 */
export function pkcs8FromPem(pem: string): Uint8Array {
  const body = PEM.exec(pem.trim())?.[1]
  if (!body) {
    throw new Error('pkcs8: not a PKCS#8 PEM private key')
  }
  return new Uint8Array(Buffer.from(body.replace(/\s+/g, ''), 'base64'))
}

/**
 * Whether a PEM text is a P-256 private key that can sign (what Apple issues for Sign in with
 * Apple). Checked when an administrator stores one, so a wrong file is refused at once instead
 * of failing every sign-in later.
 *
 * @param pem - The key's PEM text.
 * @returns `true` when the key imports as ECDSA P-256.
 */
export async function isEcP256PrivateKey(pem: string): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      'pkcs8',
      // Copied into an ArrayBuffer-backed view, as WebCrypto rejects SharedArrayBuffer views.
      new Uint8Array(pkcs8FromPem(pem)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )
    return true
  } catch {
    return false
  }
}
