import { SetMetadata } from '@nestjs/common'
import type { Role } from '../users/users.repository.js'

export interface Principal {
  id: number
  username: string
  role: Role
  accountIds: number[]
  via: 'session' | 'key'
  /** Session logins can do anything their role allows; keys are limited to their scope. */
  scope: 'full' | 'read' | 'write'
}

export const PUBLIC = 'dns:public'
export const SESSION_ONLY = 'dns:session-only'
export const ROLES_KEY = 'dns:roles'

/** No authentication required. */
export const Public = () => SetMetadata(PUBLIC, true)
/** Rejects API keys: for credential and user management, which need an interactive login. */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true)
/** Restricts a route to the listed roles. Without it any authenticated principal passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles)

/** Zone-level authorisation, kept pure so it is trivially testable. */
export function canManageZones(p: Principal): boolean {
  return p.role !== 'user'
}

export function canAccessZone(p: Principal, zone: { accountId: number | null }): boolean {
  return p.role !== 'user' || (zone.accountId !== null && p.accountIds.includes(zone.accountId))
}
