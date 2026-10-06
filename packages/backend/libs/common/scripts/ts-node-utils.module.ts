import { Module } from '@nestjs/common';
import { TsNodeUtilsService } from './ts-node-utils.service';

@Module({
  imports: [],
  providers: [TsNodeUtilsService],
  exports: [TsNodeUtilsService],
})
export class TsNodeUtilsModule {}
