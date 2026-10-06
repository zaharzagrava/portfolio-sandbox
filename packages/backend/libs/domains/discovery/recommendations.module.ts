import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { RecommendationsService } from './application/recommendations.service';
import { RecommendationsController } from './api/recommendations.controller';

/** X-01 read side (core). */
@Module({
  imports: [AuthModule, SequelizeModule.forFeature([Product])],
  providers: [RecommendationsService],
  exports: [RecommendationsService],
  controllers: [RecommendationsController],
})
export class RecommendationsModule {}
