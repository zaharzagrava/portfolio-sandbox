import { Module } from '@nestjs/common';
import { TestUtilsService } from './test-utils.service';

@Module({
  imports: [],
  providers: [TestUtilsService],
  exports: [TestUtilsService],
})
export class TestUtilsModule {}
