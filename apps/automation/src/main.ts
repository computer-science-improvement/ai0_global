import './load-env';                // must run before AppModule/ConfigModule load
import { NestFactory }             from '@nestjs/core';
import { ValidationPipe }          from '@nestjs/common';
import { NestExpressApplication }  from '@nestjs/platform-express';
import { WinstonModule }           from 'nest-winston';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as winston                from 'winston';
import cookieParser                from 'cookie-parser';
import { dataRowsJsonBody }        from './data/rows-body.middleware';
import { bootSettings }            from './settings/boot';
import { armBootSignals }          from './boot-signals';

const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';

const logger = WinstonModule.createLogger({
  level: isDev ? 'debug' : 'info',
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.colorize({ all: true }),
        winston.format.printf(({ timestamp, level, message, context }) => {
          const ctx = context ? ` [${context}]` : '';
          return `[${timestamp}]${ctx} ${level}: ${message}`;
        }),
      ),
    }),
  ],
});

// Spec 070 FR-005: a stop that lands before `enableShutdownHooks()` (below) would be ignored by PID 1 until Docker's SIGKILL.
// Exit at once instead. The listeners stay until `app.init()` has run every onModuleInit (migrations, the MTProto connect, ...);
// they are removed right before Nest registers its own.
const disarmBootSignals = armBootSignals((m) => logger.warn(m, 'Bootstrap'));

async function bootstrap() {
  // Spec 039: the dashboard's settings go into process.env BEFORE any module is loaded (ConfigService, @Cron
  // expressions and boot-time factories then read them), so AppModule is imported only after the overlay.
  await bootSettings((m) => logger.log(m, 'Settings'));
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });

  // Prod chain is host Caddy → dashboard nginx → here, all on loopback/docker
  // private addresses. Trusting only those hops makes `req.ip` the real client
  // (used by the login limiter and the auth audit) while a client-supplied X-Forwarded-For
  // from the public internet is still ignored.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use(cookieParser());
  // POST /api/data/:schema/rows (spec 032) accepts up to 5 000 rows: its own JSON parser and limit,
  // registered before Nest's default parser (which then skips the already-parsed body).
  app.use('/api/data', dataRowsJsonBody);
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });

  // Enforce class-validator decorators on every @Body() DTO. `whitelist`
  // strips unknown fields, `forbidNonWhitelisted` rejects them outright,
  // and `transform` runs class-transformer so plain JSON arrives as DTO
  // instances downstream.
  app.useGlobalPipes(new ValidationPipe({
    whitelist:             true,
    forbidNonWhitelisted:  true,
    transform:             true,
    transformOptions:      { enableImplicitConversion: true },
  }));

  // Swagger exposes the full API surface — off in production unless explicitly
  // re-enabled with SWAGGER_ENABLED=true.
  const swaggerEnabled = isDev || process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const swaggerCfg = new DocumentBuilder()
      .setTitle('ai0_global automation API')
      .setDescription('Stats + control endpoints for the automation service')
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .build();
    const doc = SwaggerModule.createDocument(app, swaggerCfg);
    SwaggerModule.setup('api/docs', app, doc);
  }

  // Spec 070 FR-005: run the module init hooks (migrations, the MTProto connect: the slow part of boot) HERE, with the boot
  // signal handler still armed, and only after every `app.use` / CORS / pipe / Swagger call above (middleware added after
  // `init()` would not apply). `listen()` skips its own init once the app is initialised.
  await app.init();
  // Booted: graceful stop on SIGTERM (docker stop, and the Settings page's "Restart service"): onModuleDestroy hooks run.
  disarmBootSignals();
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Automation service running on port ${port}`, 'Bootstrap');
  if (swaggerEnabled) logger.log(`Swagger UI: http://localhost:${port}/api/docs`, 'Bootstrap');
}

bootstrap();
