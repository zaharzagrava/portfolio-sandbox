import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ObjectStorage } from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage';

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [{ provide: ObjectStorage, useClass: S3ObjectStorage }],
  exports: [ObjectStorage],
})
export class StorageModule {}
