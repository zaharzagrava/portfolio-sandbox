import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { UserModel as User } from '@app/domains/identity';
import { SeedsService } from './seeds.service';
import { BisOrderModel as BisOrder } from '@app/domains/orders';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { ApiConfigModule } from '@app/common/config';
import { TsNodeUtilsModule } from '@app/common/scripts/ts-node-utils.module';
import Migration from '@app/infrastructure/database/migration.model';
import { ProductModel as Product } from '@app/domains/catalog';

@Module({
  imports: [
    ApiConfigModule,
    TsNodeUtilsModule,
    SequelizeModule.forFeature([User, BisOrder, Outbox, Migration, Product]),
  ],
  providers: [SeedsService],
  controllers: [],
  exports: [SeedsService],
})
export class SeedsModule {}
