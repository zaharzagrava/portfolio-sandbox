import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ShopBatchReadController } from './api/shop-batch-read.controller';

/** `GET /batch/shops` for the BFF. Its own module so only core serves it (not every app importing tenancy). */
@Module({ imports: [AuthModule], controllers: [ShopBatchReadController] })
export class ShopBatchReadModule {}
