export class ValidationError extends Error {}

/** Names are stored lowercase, absolute, without the trailing dot. The root is ''. */
export function normalizeName(input: string): string {
  const n = input.trim().toLowerCase()
  return n.endsWith('.') ? n.slice(0, -1) : n
}

export function validateName(name: string, opts: { allowWildcard?: boolean } = {}): void {
  if (name === '') return
  if (name.length > 253) throw new ValidationError(`name too long: ${name}`)
  name.split('.').forEach((label, i) => {
    if (label.length === 0) throw new ValidationError(`empty label in "${name}"`)
    if (label.length > 63) throw new ValidationError(`label too long in "${name}"`)
    if (!/^[a-z0-9_*-]+$/.test(label)) throw new ValidationError(`invalid characters in "${name}"`)
    if (label.includes('*') && !(opts.allowWildcard && label === '*' && i === 0)) {
      throw new ValidationError(`wildcard is only allowed as the first label of a record name: "${name}"`)
    }
  })
}

export function labelsOf(name: string): string[] {
  return name === '' ? [] : name.split('.')
}

export function isAtOrBelow(name: string, apex: string): boolean {
  return apex === '' || name === apex || name.endsWith('.' + apex)
}

export function parentOf(name: string): string {
  const i = name.indexOf('.')
  return i < 0 ? '' : name.slice(i + 1)
}

export function nameToWire(name: string): Buffer {
  const parts: Buffer[] = []
  for (const label of labelsOf(name)) {
    const b = Buffer.from(label, 'latin1')
    parts.push(Buffer.from([b.length]), b)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}
