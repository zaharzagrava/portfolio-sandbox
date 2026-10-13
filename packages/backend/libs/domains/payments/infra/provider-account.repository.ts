import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import type { ProviderAccountRepository } from '../domain/ledger-ports';
import ProviderAccount from './models/provider-account.model';

/** Reads the payout destination from the table payments owns (S03 follow-up: `payout.jobs.ts` no longer reads `Shop`). */
@Injectable()
export class SequelizeProviderAccountRepository implements ProviderAccountRepository {
  constructor(
    @InjectModel(ProviderAccount)
    private readonly accounts: typeof ProviderAccount,
  ) {}

  async findAccountId(shopId: string): Promise<string | null> {
    const row = await this.accounts.findByPk(shopId, {
      attributes: ['accountId'],
    });
    return row?.accountId ?? null;
  }
}
