import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { AWSApiService } from './aws-api.service';
import { TsNodeUtilsModule } from '@app/common/scripts/ts-node-utils.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';

@Module({
  imports: [
    ApiConfigModule,
    TsNodeUtilsModule,
    ErrorUtilsModule,
    DbUtilsModule,
  ],
  providers: [AWSApiService],
  exports: [AWSApiService],
  controllers: [],
})
export class AWSApiModule {}
