import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export const DB_POOL = 'DB_POOL';

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          host:     config.get('POSTGRES_HOST', 'localhost'),
          port:     config.get<number>('POSTGRES_PORT', 5432),
          database: config.get('POSTGRES_DB', 'ai0global'),
          user:     config.get('POSTGRES_USER', 'ai0'),
          password: config.get('POSTGRES_PASSWORD', 'changeme'),
        }),
    },
  ],
  exports: [DB_POOL],
})
export class DatabaseModule {}
