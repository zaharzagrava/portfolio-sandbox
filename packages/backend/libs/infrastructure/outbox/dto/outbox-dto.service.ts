import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { InjectModel } from '@nestjs/sequelize';
import Outbox, { OutboxScope, OutboxWithAllFilters } from '../outbox.model';

@Injectable()
export class OutboxDtoService {
  private readonly l = new Logger(OutboxDtoService.name);

  constructor(
    @InjectModel(Outbox) private readonly outboxModel: typeof Outbox,
  ) { }

  public async create({
    params,
    tx,
  }: {
    params: Partial<Outbox>;
    tx?: Transaction;
  }): Promise<Outbox> {
    return await this.outboxModel.create(params, { transaction: tx });
  }

  public countAll(
    params?: OutboxWithAllFilters,
    tx?: Transaction,
  ): Promise<number> {
    return this.outboxModel
      .scope({
        method: [OutboxScope.WithAll, <OutboxWithAllFilters>params],
      })
      .count({ transaction: tx });
  }

  public findAll(
    params?: OutboxWithAllFilters,
    tx?: Transaction,
  ): Promise<Outbox[]> {
    return this.outboxModel
      .scope({
        method: [OutboxScope.WithAll, <OutboxWithAllFilters>params],
      })
      .findAll({
        transaction: tx,
      });
  }

  public findOne(
    params?: OutboxWithAllFilters,
    tx?: Transaction,
  ): Promise<Outbox | null> {
    return this.outboxModel.findOne({ transaction: tx });
  }
}
