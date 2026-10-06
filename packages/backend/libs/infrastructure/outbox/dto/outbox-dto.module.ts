import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Outbox from '../outbox.model';
import { OutboxDtoService } from './outbox-dto.service';

@Module({
  imports: [SequelizeModule.forFeature([Outbox])],
  providers: [OutboxDtoService],
  exports: [OutboxDtoService],
})
export class OutboxDtoModule {}
