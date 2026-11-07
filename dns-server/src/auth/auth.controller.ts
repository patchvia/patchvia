import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { z } from 'zod'
import { parse } from '../common/parse.js'
import { UsersRepository } from '../users/users.repository.js'
import { Actor } from './actor.decorator.js'
import { AuthService } from './auth.service.js'
import { Public, SessionOnly, type Principal } from './principal.js'

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) })
const changeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string() })

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request) {
    const b = parse(loginSchema, body)
    return this.auth.login(b.username, b.password, req.ip ?? 'unknown')
  }

  @Get('me')
  me(@Actor() p: Principal) {
    return { ...this.users.get(p.id), via: p.via, scope: p.scope }
  }

  @SessionOnly()
  @Post('change-password')
  @HttpCode(200)
  changePassword(@Actor() p: Principal, @Body() body: unknown) {
    const b = parse(changeSchema, body)
    return this.auth.changePassword(p.id, b.currentPassword, b.newPassword)
  }
}
