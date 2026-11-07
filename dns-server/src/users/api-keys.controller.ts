import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { z } from 'zod'
import { Actor } from '../auth/actor.decorator.js'
import { AuthService } from '../auth/auth.service.js'
import { SessionOnly, type Principal } from '../auth/principal.js'
import { ForbiddenError } from '../common/errors.js'
import { parse } from '../common/parse.js'
import { NotFoundError } from '../zones/zone-service.js'
import { UsersRepository } from './users.repository.js'

const createSchema = z.object({ name: z.string().trim().min(1).max(64), scope: z.enum(['read', 'write']).default('read') })

/** Keys act as their owner, limited by scope, and can never manage credentials. Creating one needs an interactive login. */
@Controller('api-keys')
@SessionOnly()
export class ApiKeysController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
  ) {}

  @Get()
  list(@Actor() p: Principal, @Query('all') all?: string) {
    return this.users.listKeys(all === 'true' && p.role === 'admin' ? undefined : p.id)
  }

  @Post()
  create(@Actor() p: Principal, @Body() body: unknown) {
    const b = parse(createSchema, body)
    return this.auth.createKey(p.id, b.name, b.scope)
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Actor() p: Principal, @Param('id', ParseIntPipe) id: number) {
    const key = this.users.getKey(id)
    if (!key) throw new NotFoundError(`api key ${id} not found`)
    if (key.userId !== p.id && p.role !== 'admin') throw new ForbiddenError('not your key')
    this.users.deleteKey(id)
  }
}
