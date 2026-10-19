import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { ShopAccessService } from '@app/domains/tenancy';
import { TopicRegistry } from '@app/infrastructure/realtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `import:{importId}` (S07 FR-035, AS-55, S51): a signed-in user who is currently a member of the import's shop with
 * `products.read`. The shop is read by id from this domain's own table; the membership decision goes through tenancy's
 * exported R1 service (`assertMember`), never its tables, and is made at subscribe time, so a creator removed from the
 * shop is refused. Every refusal (no user, unknown import, not a member, a member removed a moment ago) is the same
 * `false`, exactly as for an unknown topic. No `job:` prefix is registered by this domain.
 */
@Injectable()
export class ImportJobTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    private readonly access: ShopAccessService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'import',
      owner: 'catalog-sync',
      // Terminal events are replayable (S07 AS-55): a subscriber who connects after the end, with no cursor, still gets them.
      replayFromStart: true,
      policy: async (viewer, _topic, importId) => {
        if (!viewer.userId || !UUID.test(importId)) return false;
        const [job] = await this.sequelize.query<{ shopId: string }>(
          `SELECT "shopId" FROM "ImportJob" WHERE "id" = :importId`,
          { type: QueryTypes.SELECT, replacements: { importId } },
        );
        if (!job) return false;
        try {
          await this.access.assertMember(
            job.shopId,
            viewer.userId,
            'products.read',
          );
          return true;
        } catch (error) {
          // not a member, no permission, suspended, offboarding: all "no"; an outage propagates (503 from the stream)
          if (
            typeof (error as { status?: unknown }).status === 'number' &&
            Number((error as { status: number }).status) < 500
          )
            return false;
          throw error;
        }
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    import: `import:${string}`;
  }
}
