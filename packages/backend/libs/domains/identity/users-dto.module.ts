import { Module } from '@nestjs/common';
import { UsersDtoService } from './infra/users-dto.service';
import User from './infra/models/user.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { AuthModule } from './auth.module';

@Module({
  imports: [
    SequelizeModule.forFeature([User]),
    ApiConfigModule,
    AuthModule,
  ],
  providers: [UsersDtoService],
  exports: [UsersDtoService],
  controllers: [],
})
export class UsersDtoModule { }
