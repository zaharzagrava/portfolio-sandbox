import { Injectable } from '@nestjs/common';
import { ShopProvisioningService } from '@app/domains/tenancy';
import type { ShopProvisioner } from '../domain/ports';

/** S03 R1: a seller who predates shops gets a provisioned shop; the answer is seller id → shop id. */
@Injectable()
export class ShopProvisionerAdapter implements ShopProvisioner {
  constructor(private readonly provisioning: ShopProvisioningService) {}

  ensureForSellers(sellerIds: string[]): Promise<Map<string, string>> {
    return this.provisioning.ensureShopsForLegacySellers(sellerIds);
  }
}
