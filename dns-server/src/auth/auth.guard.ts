import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { ForbiddenError } from '../common/errors.js'
import type { Role } from '../users/users.repository.js'
import { AuthService } from './auth.service.js'
import { PUBLIC, ROLES_KEY, SESSION_ONLY, type Principal } from './principal.js'

export type AuthedRequest = Request & { principal: Principal }

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true

    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const p = this.auth.authenticate(req.headers)
    req.principal = p

    if (p.via === 'key') {
      if (this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, targets)) throw new ForbiddenError('API keys cannot use this endpoint')
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && p.scope !== 'write') throw new ForbiddenError('This API key is read-only')
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets)
    if (roles && !roles.includes(p.role)) throw new ForbiddenError('Insufficient permissions')
    return true
  }
}
