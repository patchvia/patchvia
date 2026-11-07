import 'reflect-metadata'
import { VersioningType, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import type { Config } from './config/config.js'

/** Shared by the real server and the tests so both see identical routing. */
export function configure<T extends INestApplication>(app: T): T {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  // Zone files can be large
  ;(app as unknown as NestExpressApplication).useBodyParser?.('json', { limit: '10mb' })
  return app
}

export async function createApp(cfg: Config): Promise<NestExpressApplication> {
  const app = configure(await NestFactory.create<NestExpressApplication>(AppModule.register(cfg), { bodyParser: true, logger: ['log', 'warn', 'error'] }))
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.enableShutdownHooks()
  return app
}
