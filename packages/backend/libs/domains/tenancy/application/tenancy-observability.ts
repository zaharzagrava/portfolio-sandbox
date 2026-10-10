import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@app/infrastructure/context';

export type TenancyAuditAction =
  | 'shop.created'
  | 'shop.updated'
  | 'member.role_changed'
  | 'member.removed'
  | 'invite.created'
  | 'invite.accepted'
  | 'invite.revoked'
  | 'invite.resent'
  | 'sso.configured'
  | 'sso.removed'
  | 'shop.offboarding_started'
  | 'shop.offboarding_cancelled'
  | 'shop.status_changed'
  | 'shop.cell_moved';

/**
 * Audit lines for tenancy mutations (VIII.1, AS-81): `{action, actorId, shopId, requestId, ...ids}`. Identifiers only:
 * never an e-mail address, an invite token or a secret.
 */
@Injectable()
export class TenancyAudit {
  private readonly logger = new Logger('Audit');

  constructor(private readonly context: RequestContext) {}

  record(
    action: TenancyAuditAction,
    fields: { actorId: string; shopId: string } & Record<
      string,
      string | undefined
    >,
  ): void {
    this.logger.log({
      action,
      requestId: this.context.requestId,
      ...fields,
    });
  }
}
