import { NestFactory }   from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import * as winston      from 'winston';
import { AppModule }     from './app.module';

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
  const app = await NestFactory.create(AppModule, { logger });
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Automation service running on port ${port}`, 'Bootstrap');
}

bootstrap();
