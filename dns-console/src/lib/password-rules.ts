export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

/** A random password using an unambiguous alphabet, for "generate" buttons. Browser-only (Web Crypto). */
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Rejection sampling avoids modulo bias
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    if (bytes[i]! < limit) out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
