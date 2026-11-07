import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common'
import type { Request } from 'express'
import { tap } from 'rxjs'
import { CLUSTER, type ClusterRuntime } from './cluster.runtime.js'

/** After any successful change made through the API, have the cluster look for new local changes soon. */
@Injectable()
export class ClusterTouchInterceptor implements NestInterceptor {
  constructor(@Inject(CLUSTER) private readonly cluster: ClusterRuntime | null) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<Request>()
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/cluster/')
    return next.handle().pipe(
      tap(() => {
        if (writes) this.cluster?.service.smallTouched()
      }),
    )
  }
}
