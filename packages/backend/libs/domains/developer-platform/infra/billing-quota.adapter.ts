import { Injectable } from '@nestjs/common';
import { QuotaAnswer, QuotaPort, QuotaUnavailable } from '../domain/ports';

/**
 * The billing capability's `checkQuota('SHOP', shopId, 'apiCallsPerMonth')` (S18) is not exported yet, so there is
 * nothing to ask: the adapter says so, the gate serves the call and counts it (`public_api_quota_degraded_total
 * {reason="not_available"}`). When S18 exports the check, only this class changes.
 */
@Injectable()
export class BillingQuotaAdapter extends QuotaPort {
  check(_shopId: string): Promise<QuotaAnswer> {
    return Promise.reject(new QuotaUnavailable('not_available'));
  }
}
