import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { ValidationError } from '../dns/names.js'
import { ConflictError, NotFoundError } from '../zones/zone-service.js'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from './errors.js'

/** Maps domain errors to HTTP statuses so controllers never deal with status codes for failures. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http')

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    const send = (statusCode: number, message: string) => res.status(statusCode).json({ statusCode, message })

    if (err instanceof HttpException) {
      const body = err.getResponse()
      const message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? err.message)
      return send(err.getStatus(), Array.isArray(message) ? message.join('; ') : message)
    }
    if (err instanceof ValidationError) return send(400, err.message)
    if (err instanceof UnauthorizedError) return send(401, err.message || 'Unauthorized')
    if (err instanceof ForbiddenError) return send(403, err.message || 'Forbidden')
    if (err instanceof NotFoundError) return send(404, err.message)
    if (err instanceof ConflictError) return send(409, err.message)
    if (err instanceof TooManyRequestsError) return send(429, err.message)
    const code = (err as { code?: string }).code
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') return send(409, 'already exists')
    if (code?.startsWith('SQLITE_CONSTRAINT')) return send(400, 'invalid reference')
    this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    return send(500, 'Internal server error')
  }
}
