import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Product from './infra/models/product.model';
import { ProductDtoService } from './infra/product-dto.service';

@Module({
  imports: [SequelizeModule.forFeature([Product])],
  providers: [ProductDtoService],
  exports: [ProductDtoService],
})
export class ProductDtoModule {}
