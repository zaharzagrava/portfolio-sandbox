import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Op, Sequelize } from 'sequelize';
import SigningKey from '../models/signing-key.model';
import { KeyStore } from './key-store.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auth.rotate-signing-keys': { activeMaxAgeDays?: number };
  }
}

const DAY = 86_400_000;

/**
 * Daily (apps/worker): keep a NEXT key published ≥ 1 day before it signs
 * (verifiers' JWKS caches - edge, services - must know it first), promote it
 * when ACTIVE is older than `activeMaxAgeDays`, keep RETIRED keys published
 * until tokens they signed have expired, then delete them.
 */
@Injectable()
export class KeyRotationJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeyRotationJobs.name);

  constructor(
    @InjectModel(SigningKey) private readonly keyModel: typeof SigningKey,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly keys: KeyStore,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'auth.rotate-signing-keys', cron: '0 4 * * *', jobType: 'auth.rotate-signing-keys', payload: {} });
    await this.rotate({});
  }

  @JobHandler('auth.rotate-signing-keys', { concurrency: 1 })
  async rotate({ activeMaxAgeDays = 7 }: { activeMaxAgeDays?: number }): Promise<void> {
    const all = await this.keyModel.findAll();
    const active = all.find((k) => k.status === 'ACTIVE');
    const next = all.find((k) => k.status === 'NEXT');

    if (!active) {
      // First boot. The partial unique index makes concurrent bootstraps safe: one wins, the other fails here.
      await this.keys.createKey('ACTIVE').catch((e) => this.logger.warn(`bootstrap ACTIVE key: ${e.message}`));
    } else if (next && Date.now() - next.createdAt.getTime() > DAY && Date.now() - (active.activatedAt?.getTime() ?? 0) > activeMaxAgeDays * DAY) {
      await this.sequelize.transaction(async (transaction) => {
        await active.update({ status: 'RETIRED', retiredAt: new Date() }, { transaction });
        await next.update({ status: 'ACTIVE', activatedAt: new Date() }, { transaction });
      });
      this.logger.log(`rotated signing key ${active.kid} → ${next.kid}`);
    }

    if (!(await this.keyModel.count({ where: { status: 'NEXT' } }))) await this.keys.createKey('NEXT');

    // Access tokens live ≤ 1 h; keep retired keys 2 days to be safe, then drop them from JWKS.
    await this.keyModel.destroy({ where: { status: 'RETIRED', retiredAt: { [Op.lt]: new Date(Date.now() - 2 * DAY) } } });
    this.keys.invalidate();
  }
}
