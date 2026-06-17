// crypto.module.ts — exposes SecretsService app-wide. @Global so every token
// read site can inject it without each feature module re-declaring it.
import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';

@Global()
@Module({
  providers: [SecretsService],
  exports:   [SecretsService],
})
export class CryptoModule {}
