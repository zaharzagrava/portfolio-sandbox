import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Sequelize, Transaction } from 'sequelize';

@Injectable()
export class DbUtilsService {
  constructor(
    private readonly configService: ApiConfigService,
    @InjectConnection() private readonly sequelizeInstance: Sequelize,
  ) { }

  public async wrapInTransaction<T>(
    fun: (transaction: Transaction) => T,
    transaction?: Transaction,
  ): Promise<T> {
    if (transaction) {
      return await fun(transaction);
    }

    return await this.sequelizeInstance.transaction(async (transaction) => {
      return await fun(transaction);
    });
  }
}
