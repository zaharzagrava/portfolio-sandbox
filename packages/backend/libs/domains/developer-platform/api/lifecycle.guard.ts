import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ShopStatusGate } from '../application/shop-status.gate';
import type { VerifiedKey } from '../application/key-verifier.service';

/** A key of a suspended or offboarding shop is refused for reads and writes alike (FR-017). */
@Injectable()
export class LifecycleGuard implements CanActivate {
  constructor(private readonly gate: ShopStatusGate) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ apiKey?: VerifiedKey }>();
    if (req.apiKey) await this.gate.assertOpen(req.apiKey.liveShopId);
    return true;
  }
}
