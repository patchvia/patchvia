import type { z } from 'zod'
import { ValidationError } from '../dns/names.js'

/** Validates untrusted input; failures become a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  }
  return r.data
}
