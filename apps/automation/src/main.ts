import './load-env';                // must run before AppModule/ConfigModule load
import { NestFactory }             from '@nestjs/core';
import { ValidationPipe }          from '@nestjs/common';
import { NestExpressApplication }  from '@nestjs/platform-express';
import { WinstonModule }           from 'nest-winston';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as winston                from 'winston';
import cookieParser                from 'cookie-parser';
import { AppModule }               from './app.module';

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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });

  // Prod chain is host Caddy → dashboard nginx → here, all on loopback/docker
  // private addresses. Trusting only those hops makes `req.ip` the real client
  // (used by the login RateLimitGuard) while a client-supplied X-Forwarded-For
  // from the public internet is still ignored.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use(cookieParser());
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

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Automation service running on port ${port}`, 'Bootstrap');
  if (swaggerEnabled) logger.log(`Swagger UI: http://localhost:${port}/api/docs`, 'Bootstrap');
}

bootstrap();
