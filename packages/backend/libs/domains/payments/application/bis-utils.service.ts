import { Injectable } from '@nestjs/common';
import { LedgerAccountId, SystemAccount } from '../api/ledger.dto';

@Injectable()
export class BisUtilsService {
  public getMerchantAccountId = (merchantId: string | number): LedgerAccountId => {
    return `MERCHANT_${merchantId}`;
  };

  public getUserAccountId = (userId: string | number): LedgerAccountId => {
    return `USER_${userId}`;
  };
}
