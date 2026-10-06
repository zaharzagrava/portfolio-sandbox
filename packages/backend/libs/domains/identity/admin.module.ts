import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AdminController } from './api/admin.controller';
import { AdminService } from './application/admin.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import User from './infra/models/user.model';

@Module({
  imports: [
    SequelizeModule.forFeature([User]),
    ApiConfigModule,
  ],
  providers: [AdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule { }
