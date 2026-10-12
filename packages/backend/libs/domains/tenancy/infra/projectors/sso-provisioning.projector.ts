import { Injectable } from '@nestjs/common';
import { FederatedIdentityLinked } from '@app/domains/identity';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { SsoProvisioningService } from '../../application/sso-provisioning.service';

/**
 * `identity.federated_identity_linked` → membership for shop-provider sign-ins (AS-47 to AS-49). Only `userId` and
 * `provider` are read. The framework records `(consumer, eventId)` in the effect's transaction (`inbox`, kept 30 days
 * like the topic), so a redelivery after the member was removed cannot add them again.
 */
@Injectable()
export class SsoProvisioningProjector implements Projector {
  readonly name = 'tenancy-sso-provisioning';
  readonly topics = [FederatedIdentityLinked.topic];
  readonly idempotency = 'inbox' as const;
  readonly handles = [{ event: FederatedIdentityLinked }];

  constructor(private readonly provisioning: SsoProvisioningService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      let event: ReturnType<typeof FederatedIdentityLinked.match>;
      try {
        event = FederatedIdentityLinked.match(raw);
      } catch (error) {
        throw new PermanentError(
          `invalid ${raw.type} payload: ${(error as Error).message}`,
        );
      }
      if (!event) continue;
      const outcome = await this.provisioning.provision(
        event.payload.userId,
        event.payload.provider,
      );
      if (outcome === 'provisioned') counts.applied++;
      else counts.stale++;
    }
    return counts;
  }
}
