import { Module } from '@nestjs/common';
import { ErrorUtilsService } from './error-utils.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';

@Module({
  imports: [ApiConfigModule],
  providers: [ErrorUtilsService],
  exports: [ErrorUtilsService],
})
export class ErrorUtilsModule {}
