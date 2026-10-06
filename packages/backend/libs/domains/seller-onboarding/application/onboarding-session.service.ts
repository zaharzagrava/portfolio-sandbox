import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DomainEventsService } from '@app/infrastructure/events/domain-events.service';
import { Answers, AnswersSchema, requiredDocuments, STEP_NAMES, StepName, STEPS } from '../domain/questionnaire';
import { OnboardingSubmitted } from './events/onboarding-events';

const sessionKey = (shopId: string) => `onboarding:{${shopId}}`;
/** Sliding: every save extends it, so an abandoned draft cleans itself up a week after the last touch. */
const SESSION_TTL_S = 7 * 86_400;

/**
 * Questionnaire drafts live in a Redis hash (one field per step) - no OLTP
 * rows for half-finished onboarding, nothing to garbage-collect. Submit
 * re-validates the whole set and writes answers + outbox event in ONE
 * transaction; the draft is dropped only after that commits.
 */
@Injectable()
export class OnboardingSessionService {
  constructor(
    private readonly redis: RedisService,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly events: DomainEventsService,
  ) {}

  async saveStep(shopId: string, step: StepName, body: unknown) {
    if (!STEP_NAMES.includes(step)) throw new BadRequestException(`Unknown step ${step}`);
    const parsed = STEPS[step].safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    await this.assertNotSubmitted(shopId);
    await this.redis.client.multi().hset(sessionKey(shopId), step, JSON.stringify(parsed.data)).expire(sessionKey(shopId), SESSION_TTL_S).exec();
    return this.get(shopId);
  }

  async get(shopId: string) {
    const raw = await this.redis.client.hgetall(sessionKey(shopId));
    const answers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v)])) as Partial<Answers>;
    return { answers, missingSteps: STEP_NAMES.filter((s) => !answers[s]), submitted: await this.submitted(shopId) };
  }

  async submit(shopId: string, userId: string) {
    const { answers } = await this.get(shopId);
    const parsed = AnswersSchema.safeParse(answers);
    if (!parsed.success) {
      const existing = await this.submitted(shopId);
      if (existing) return existing; // retried submit after the draft was already consumed
      throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const required = requiredDocuments(parsed.data);

    const inserted = await this.sequelize.transaction(async (transaction) => {
      const [row] = await this.sequelize.query<{ shopId: string }>(
        `INSERT INTO "ShopOnboarding" ("shopId", answers, "submittedBy") VALUES (:shopId, CAST(:answers AS jsonb), :userId)
         ON CONFLICT ("shopId") DO NOTHING RETURNING "shopId"`,
        { type: QueryTypes.SELECT, transaction, replacements: { shopId, answers: JSON.stringify(parsed.data), userId } },
      );
      if (!row) return false;
      await this.sequelize.query(`UPDATE "Shop" SET "verificationStatus" = 'PENDING', "updatedAt" = now() WHERE id = :shopId AND "verificationStatus" = 'UNVERIFIED'`, {
        transaction,
        replacements: { shopId },
      });
      await this.events.record(
        OnboardingSubmitted.create(shopId, 1, { shopId, country: parsed.data.business.country, legalForm: parsed.data.business.legalForm, requiredDocuments: required }),
        transaction,
      );
      return true;
    });
    await this.redis.client.del(sessionKey(shopId));
    // Idempotent: a concurrent/retried submit gets the stored outcome, not an error.
    return inserted ? { submitted: true as const, requiredDocuments: required } : (await this.submitted(shopId))!;
  }

  async answers(shopId: string): Promise<Answers | null> {
    const [row] = await this.sequelize.query<{ answers: Answers }>(`SELECT answers FROM "ShopOnboarding" WHERE "shopId" = :shopId`, { type: QueryTypes.SELECT, replacements: { shopId } });
    return row?.answers ?? null;
  }

  private async submitted(shopId: string) {
    const answers = await this.answers(shopId);
    return answers ? { submitted: true as const, requiredDocuments: requiredDocuments(answers) } : null;
  }

  private async assertNotSubmitted(shopId: string) {
    if (await this.answers(shopId)) throw new ConflictException('Onboarding was already submitted');
  }
}
