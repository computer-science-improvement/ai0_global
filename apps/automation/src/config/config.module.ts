import { Module, Global } from '@nestjs/common';
import { ChannelConfigService } from './channel-config.service';

@Global()
@Module({
  providers: [ChannelConfigService],
  exports:   [ChannelConfigService],
})
export class ChannelConfigModule {}
