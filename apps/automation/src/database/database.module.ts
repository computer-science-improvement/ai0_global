import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DB_POOL } from './database.tokens';
import { MigrationRunnerService } from './migration-runner.service';

export { DB_POOL };

const poolProvider = {
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
};

@Global()
@Module({
  providers: [poolProvider, MigrationRunnerService],
  exports:   [DB_POOL, MigrationRunnerService],
})
export class DatabaseModule {}
