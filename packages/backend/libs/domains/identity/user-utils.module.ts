import { Module } from '@nestjs/common';
import { UserUtilsService } from './application/user-utils.service';

@Module({
  imports: [],
  providers: [UserUtilsService],
  exports: [UserUtilsService],
})
export class UserUtilsModule {}
