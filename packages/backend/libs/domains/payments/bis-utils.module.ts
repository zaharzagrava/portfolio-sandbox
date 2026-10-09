import { Module } from '@nestjs/common';
import { BisUtilsService } from './application/bis-utils.service';

@Module({
  imports: [],
  providers: [BisUtilsService],
  exports: [BisUtilsService],
})
export class BisUtilsModule {}
