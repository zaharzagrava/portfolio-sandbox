import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AdmissionService } from '../application/admission.service';
import { admissionRequired } from '../domain/errors';

type HoldRequest = Request & { user?: { id: string } };

/**
 * Verifies the `X-Admission-Token` of the hold route before the idempotency interceptor, the pipes or any store run (FR-013,
 * AS-18). It is declared above `@Firewall()` on the route, so the session is already authenticated when it runs. The
 * token is read from the header and handed to the application service; it is never logged here.
 */
@Injectable()
export class AdmissionGuard implements CanActivate {
  constructor(private readonly admission: AdmissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HoldRequest>();
    const userId = req.user?.id;
    const eventId = String(req.params.eventId ?? '');
    if (!userId) throw admissionRequired();
    const header = req.headers['x-admission-token'];
    await this.admission.assertAdmitted(
      typeof header === 'string' ? header : undefined,
      eventId.toLowerCase(),
      userId,
    );
    return true;
  }
}
