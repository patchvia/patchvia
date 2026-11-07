import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/** Per-purpose key so a value sealed for one use can never be opened as another. */
function key(secret: string, purpose: string) {
  return createHash('sha256').update(`${purpose}\0${secret}`).digest();
}

/** AES-256-GCM: confidentiality and integrity. Format: iv.tag.ciphertext (base64url) */
export function seal(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((b) => b.toString('base64url'))
    .join('.');
}

export function open(
  value: string | undefined,
  secret: string,
  purpose: string,
): string | null {
  if (!value) return null;
  try {
    const [iv, tag, body] = value
      .split('.')
      .map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16)
      return null;
    const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}
