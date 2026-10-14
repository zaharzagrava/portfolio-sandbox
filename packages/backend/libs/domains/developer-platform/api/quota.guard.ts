import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { QuotaGate } from '../application/quota.gate';
import type { VerifiedKey } from '../application/key-verifier.service';

/** The plan quota, after the key, the shop, the version and the scope are known (FR-053). */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private readonly gate: QuotaGate) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ apiKey?: VerifiedKey }>();
    if (req.apiKey) await this.gate.assert(req.apiKey);
    return true;
  }
}
