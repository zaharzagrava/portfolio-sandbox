import { Module } from '@nestjs/common';
import { DbUtilsService } from './db-utils.service';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config/api-config.module';

@Module({
  imports: [SequelizeModule.forFeature([]), ApiConfigModule],
  providers: [DbUtilsService],
  exports: [DbUtilsService],
})
export class DbUtilsModule {}
