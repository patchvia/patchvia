import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { AuthedRequest } from './auth.guard.js'
import type { Principal } from './principal.js'

/** Injects the authenticated principal into a controller method. */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<AuthedRequest>().principal)
