import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post } from '@nestjs/common'
import { z } from 'zod'
import { Actor } from '../auth/actor.decorator.js'
import { Roles, SessionOnly, type Principal } from '../auth/principal.js'
import { parse } from '../common/parse.js'
import { ROLES } from './users.repository.js'
import { UsersService } from './users.service.js'

const role = z.enum(ROLES as unknown as [string, ...string[]]) as z.ZodType<'admin' | 'operator' | 'user'>
const createSchema = z.object({
  username: z.string(),
  password: z.string(),
  role,
  accountIds: z.array(z.number().int()).optional(),
})
const updateSchema = z.object({ role: role.optional(), password: z.string().optional(), accountIds: z.array(z.number().int()).optional() })
const accountSchema = z.object({ name: z.string().trim().min(1).max(64), description: z.string().max(500).optional() })

@Controller('users')
@Roles('admin')
@SessionOnly()
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list()
  }

  @Post()
  create(@Body() body: unknown) {
    return this.users.create(parse(createSchema, body))
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.users.get(id)
  }

  @Patch(':id')
  update(@Actor() actor: Principal, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.users.update(actor.id, id, parse(updateSchema, body))
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Actor() actor: Principal, @Param('id', ParseIntPipe) id: number) {
    this.users.delete(actor.id, id)
  }
}

@Controller('accounts')
export class AccountsController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Roles('admin', 'operator')
  list() {
    return this.users.listAccounts()
  }

  @Post()
  @Roles('admin')
  create(@Body() body: unknown) {
    const b = parse(accountSchema, body)
    return this.users.createAccount(b.name, b.description)
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.users.updateAccount(id, parse(accountSchema.partial(), body))
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number) {
    this.users.deleteAccount(id)
  }
}
