import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { MediaService } from './application/media.service';
import { MediaController } from './api/media.controller';

/** SD-10 API side (core). Processing runs in the `media-processing` Lambda (apps/lambdas). */
@Module({ imports: [AuthModule, StorageModule, SqsModule], providers: [MediaService], exports: [MediaService], controllers: [MediaController] })
export class MediaModule {}
