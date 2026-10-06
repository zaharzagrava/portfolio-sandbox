import { Module } from '@nestjs/common';
import { ConfigUtilsService } from './config-utils.service';

@Module({
  imports: [],
  providers: [ConfigUtilsService],
  exports: [ConfigUtilsService],
})
export class ConfigUtilsModule {}
