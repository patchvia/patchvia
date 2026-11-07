import { readFileSync } from 'node:fs';

/**
 * A setting from its variable, or, when that is not set, from the file a `<NAME>_FILE` variable points to (how Docker
 * secrets are delivered). A plain variable wins when both are set. Undefined when neither is.
 */
export function valueOrFile(
  name: string,
  env: Record<string, string | undefined>,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string | undefined {
  const plain = env[name];
  if (plain) return plain;
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  try {
    return read(file).trim() || undefined;
  } catch {
    throw new Error(`${name}_FILE points to ${file}, which cannot be read.`);
  }
}
