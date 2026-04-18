import { Global, Module } from '@nestjs/common';
import { StructuredLoggerService } from './structured-logger.service';
import { LogAnalyzerAgent } from './log-analyzer.agent';

@Global()
@Module({
  providers: [StructuredLoggerService, LogAnalyzerAgent],
  exports:   [StructuredLoggerService, LogAnalyzerAgent],
})
export class LoggingModule {}
