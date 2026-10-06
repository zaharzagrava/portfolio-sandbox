import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { signClick, verifyClick } from '../domain/click-token';

export const ADS_CLICKS_TOPIC = 'ads.clicks';
/** A viral ad must not funnel 50k clicks/s into ONE partition: spread over 10 salted keys, merged downstream. */
export const HOT_KEY_SALTS = 10;
const TOKEN_TTL_MS = 30 * 60_000;
const IP_BURST_PER_MIN = 20;
const spendKey = (campaignId: string, day: string) => `adspend:{${campaignId}}:${day}`;

export interface ClickRecord {
  click_id: string;
  campaign_id: string;
  shop_id: string;
  ts: string;
  ip_hash: string;
  valid: number;
}

@Injectable()
export class AdsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly producer: KafkaProducerService,
    private readonly config: ApiConfigService,
  ) {}

  private get secret() {
    return this.config.get('share_link_secret') || this.config.get('jwt_secret');
  }

  createCampaign(shopId: string, input: { productId: string; category: string; cpcCents: number; dailyBudgetCents: number }) {
    return this.sequelize.query(
      `INSERT INTO "AdCampaign" ("shopId", "productId", category, "cpcCents", "dailyBudgetCents")
       SELECT :shopId, p.id, :category, :cpcCents, :dailyBudgetCents FROM "Product" p WHERE p.id = :productId AND p."shopId" = :shopId
       RETURNING *`,
      { type: QueryTypes.SELECT, replacements: { shopId, ...input } },
    );
  }

  /** Up to 3 sponsored slots: highest CPC among campaigns with budget left today (approximate spend from click counters). */
  async sponsored(category: string, viewerKey: string) {
    const day = new Date().toISOString().slice(0, 10);
    const campaigns = await this.sequelize.query<{ id: string; shopId: string; productId: string; cpcCents: number; dailyBudgetCents: number; title: string }>(
      `SELECT c.id, c."shopId", c."productId", c."cpcCents", c."dailyBudgetCents", p.title FROM "AdCampaign" c JOIN "Product" p ON p.id = c."productId"
       WHERE c.status = 'ACTIVE' AND c.category = :category AND p.quantity > 0 ORDER BY c."cpcCents" DESC LIMIT 10`,
      { type: QueryTypes.SELECT, replacements: { category } },
    );
    const spends = campaigns.length ? await this.redis.client.mget(...campaigns.map((c) => spendKey(c.id, day))) : [];
    return campaigns
      .filter((c, i) => Number(spends[i] ?? 0) + c.cpcCents <= c.dailyBudgetCents)
      .slice(0, 3)
      .map((c) => {
        const token = signClick({ i: uuidv7(), c: c.id, s: c.shopId, p: c.productId, e: Date.now() + TOKEN_TTL_MS }, this.secret);
        return { campaignId: c.id, productId: c.productId, title: c.title, sponsored: true, clickUrl: `/api/ads/click/${token}`, viewer: createHash('sha256').update(viewerKey).digest('hex').slice(0, 8) };
      });
  }

  /**
   * The click path: verify → dedupe per impression (SET NX) → burst filter per
   * IP → produce (salted key) → redirect. The user is ALWAYS redirected;
   * whether the click is billable is decided here and recorded as `valid`.
   */
  async click(token: string, ip: string): Promise<{ redirectTo: string; counted: boolean; valid: boolean }> {
    const claims = verifyClick(token, this.secret);
    if (!claims) return { redirectTo: '/', counted: false, valid: false };
    const redirectTo = `/p/${claims.p}?ad=1`;
    if (!(await this.redis.client.set(`adclick:${claims.i}`, '1', 'EX', 3600, 'NX'))) return { redirectTo, counted: false, valid: false };

    const ipHash = createHash('sha256').update(`${this.secret}:${ip}`).digest('hex').slice(0, 16);
    const minute = Math.floor(Date.now() / 60_000);
    const burst = await this.redis.client.multi().incr(`adclick:ip:${ipHash}:${minute}`).expire(`adclick:ip:${ipHash}:${minute}`, 120).exec();
    const valid = Number(burst?.[0]?.[1] ?? 0) <= IP_BURST_PER_MIN;

    const record: ClickRecord = { click_id: claims.i, campaign_id: claims.c, shop_id: claims.s, ts: new Date().toISOString().replace('T', ' ').replace('Z', ''), ip_hash: ipHash, valid: valid ? 1 : 0 };
    await this.producer.send({ topic: ADS_CLICKS_TOPIC, key: `${claims.c}#${Math.floor(Math.random() * HOT_KEY_SALTS)}`, value: record });
    if (valid) {
      const [cpc] = await this.sequelize.query<{ cpcCents: number }>(`SELECT "cpcCents" FROM "AdCampaign" WHERE id = :id`, { type: QueryTypes.SELECT, replacements: { id: claims.c } });
      if (cpc) await this.redis.client.multi().incrby(spendKey(claims.c, new Date().toISOString().slice(0, 10)), cpc.cpcCents).expire(spendKey(claims.c, new Date().toISOString().slice(0, 10)), 2 * 86_400).exec();
    }
    return { redirectTo, counted: true, valid };
  }
}
