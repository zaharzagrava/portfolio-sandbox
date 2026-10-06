import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { OutboxDtoModule } from './dto/outbox-dto.module';
import Outbox from './outbox.model';
import { OutboxService } from './outbox.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Outbox]),
    ApiConfigModule,
    DbUtilsModule,
    OutboxDtoModule,
  ],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule { }
