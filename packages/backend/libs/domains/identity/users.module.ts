import { Module } from '@nestjs/common';
import { UsersService } from './application/users.service';
import { UsersController } from './api/users.controller';
import { FirebaseModule } from '@app/infrastructure/firebase/firebase.module';
import User from './infra/models/user.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { AuthModule } from './auth.module';
import { UserUtilsModule } from './user-utils.module';
import { UsersDtoModule } from './users-dto.module';
import { AWSApiModule } from '@app/infrastructure/aws/aws-api.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { TsNodeUtilsModule } from '@app/common/scripts/ts-node-utils.module';

@Module({
  imports: [
    SequelizeModule.forFeature([User]),
    FirebaseModule,
    ApiConfigModule,
    DbUtilsModule,
    AuthModule,
    UserUtilsModule,
    UsersDtoModule,
    AWSApiModule,
    StripeModule,
    TsNodeUtilsModule,
  ],
  providers: [UsersService],
  exports: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
