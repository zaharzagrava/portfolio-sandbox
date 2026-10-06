import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductBatchReadController } from './api/product-batch-read.controller';

/** `GET /batch/products` for the BFF. Its own module so only core serves it (not every app importing catalog). */
@Module({ imports: [AuthModule], controllers: [ProductBatchReadController] })
export class ProductBatchReadModule {}
