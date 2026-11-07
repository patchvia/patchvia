import { isIP } from 'node:net'

export const isIPLiteral = (s: string): boolean => isIP(s) !== 0
