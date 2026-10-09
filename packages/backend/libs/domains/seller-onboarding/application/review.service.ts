import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { metrics } from '@opentelemetry/api';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { SecretBox } from '@app/domains/identity';
import { PROMPT_VERSION, SENSITIVE_FIELDS } from '../domain/extraction-schema';
import type { Extraction } from '../domain/extraction-schema';
import { isValidIban, isValidVat, maskIban } from '../domain/validators';
import { VerificationService } from './verification.service';

export interface ResolveInput {
  decision: 'APPROVE' | 'REJECT';
  /** field → corrected value (only fields the reviewer changed). */
  corrections?: Record<string, string>;
  reason?: string;
}

/**
 * Human-in-the-loop queue (10/10 #44). Reviewers see masked values, the
 * reasons the pipeline stopped, and a short-lived link to the file.
 * Corrections are stored as {extracted, corrected} pairs: the labelled data
 * for the extraction eval set, and the per-field correction-rate metric that
 * says which field the prompt or model gets wrong.
 */
@Injectable()
export class ReviewService {
  private readonly corrections = metrics
    .getMeter('onboarding')
    .createCounter('kyc_field_corrections_total');
  private readonly decisions = metrics
    .getMeter('onboarding')
    .createCounter('kyc_review_decisions_total');

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretBox,
    private readonly verification: VerificationService,
  ) {}

  async queue(limit = 50) {
    const rows = await this.sequelize.query<{
      id: string;
      documentId: string;
      shopId: string;
      shopName: string;
      kind: string;
      reasons: unknown;
      storageKey: string;
      purgedAt: Date | null;
      fields: unknown;
      model: string;
      createdAt: Date;
    }>(
      `SELECT t.id, t."documentId", t."shopId", s.name AS "shopName", d.kind, t.reasons, d."storageKey", d."purgedAt", e.fields, e.model, t."createdAt"
       FROM "ReviewTask" t
       JOIN "ShopDocument" d ON d.id = t."documentId" AND d.status = 'NEEDS_REVIEW'
       JOIN "Shop" s ON s.id = t."shopId"
       LEFT JOIN LATERAL (SELECT fields, model FROM "DocumentExtraction" WHERE "documentId" = d.id ORDER BY attempt DESC LIMIT 1) e ON true
       WHERE t.status = 'OPEN'
       ORDER BY t."createdAt"
       LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    );
    return Promise.all(
      rows.map(async ({ storageKey, purgedAt, ...task }) => ({
        ...task,
        fileUrl: purgedAt
          ? null
          : await this.storage.presignGet(storageKey, { expiresInSec: 300 }),
      })),
    );
  }

  async resolve(
    taskId: string,
    reviewerId: string,
    input: ResolveInput,
  ): Promise<{ status: string; shopVerified: boolean }> {
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    const result = await this.sequelize.transaction(async (transaction) => {
      const [task] = await this.sequelize.query<{
        id: string;
        documentId: string;
        shopId: string;
        kind: string;
        docStatus: string;
        country: string | null;
      }>(
        `SELECT t.id, t."documentId", t."shopId", d.kind, d.status AS "docStatus", o.answers->'business'->>'country' AS country
         FROM "ReviewTask" t JOIN "ShopDocument" d ON d.id = t."documentId" LEFT JOIN "ShopOnboarding" o ON o."shopId" = t."shopId"
         WHERE t.id = :taskId AND t.status = 'OPEN' FOR UPDATE OF t`,
        { type: QueryTypes.SELECT, transaction, replacements: { taskId } },
      );
      if (!task) throw new NotFoundException('No open review task');
      if (task.docStatus !== 'NEEDS_REVIEW')
        throw new ConflictException(
          'The document was replaced by a newer upload',
        );

      if (input.decision === 'REJECT') {
        await this.sequelize.query(
          `UPDATE "ReviewTask" SET status = 'REJECTED', "resolvedBy" = :reviewerId, "resolvedAt" = now() WHERE id = :taskId`,
          { transaction, replacements: { taskId, reviewerId } },
        );
        await this.sequelize.query(
          `UPDATE "ShopDocument" SET status = 'REJECTED', "rejectionReason" = :reason, "updatedAt" = now() WHERE id = :id`,
          {
            transaction,
            replacements: {
              id: task.documentId,
              reason: input.reason ?? 'Document could not be verified',
            },
          },
        );
        return { status: 'REJECTED', shopId: task.shopId, kind: task.kind };
      }

      const [latest] = await this.sequelize.query<{
        attempt: number;
        sealedFields: string;
      }>(
        `SELECT attempt, "sealedFields" FROM "DocumentExtraction" WHERE "documentId" = :documentId ORDER BY attempt DESC LIMIT 1`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: { documentId: task.documentId },
        },
      );
      const extracted = latest
        ? (JSON.parse(
            this.secrets.open(latest.sealedFields),
          ) as Extraction | null)
        : null;
      const values: Record<string, string | null> = Object.fromEntries(
        Object.entries(extracted?.fields ?? {}).map(([f, fv]) => [f, fv.value]),
      );
      const diff: Record<
        string,
        { extracted: string | null; corrected: string }
      > = {};
      for (const [field, corrected] of Object.entries(
        input.corrections ?? {},
      )) {
        if (values[field] !== corrected)
          diff[field] = {
            extracted:
              SENSITIVE_FIELDS.has(field) && values[field]
                ? maskIban(values[field])
                : (values[field] ?? null),
            corrected: SENSITIVE_FIELDS.has(field)
              ? maskIban(corrected)
              : corrected,
          };
        values[field] = corrected;
      }

      // A human can't approve what the hard checks reject.
      if (
        task.kind === 'BANK_STATEMENT' &&
        !(values.iban && isValidIban(values.iban))
      )
        throw new UnprocessableEntityException('IBAN fails the checksum');
      if (
        task.kind === 'VAT_CERTIFICATE' &&
        !(
          values.vatNumber &&
          isValidVat(
            (values.country ?? task.country ?? '').toUpperCase(),
            values.vatNumber,
          )
        )
      ) {
        throw new UnprocessableEntityException('VAT number is not valid');
      }

      const final = {
        documentType: task.kind,
        legible: true,
        fields: Object.fromEntries(
          Object.entries(values).map(([f, v]) => [
            f,
            { value: v, confidence: 'high', evidence: null },
          ]),
        ),
      };
      await this.sequelize.query(
        `INSERT INTO "DocumentExtraction" ("documentId", attempt, model, "promptVersion", fields, "sealedFields", issues, outcome, "inputTokens", "outputTokens")
         VALUES (:documentId, :attempt, 'human', :promptVersion, CAST(:fields AS jsonb), :sealed, '[]'::jsonb, 'ACCEPTED', 0, 0)`,
        {
          transaction,
          replacements: {
            documentId: task.documentId,
            attempt: (latest?.attempt ?? 0) + 1,
            promptVersion: PROMPT_VERSION,
            fields: JSON.stringify({
              documentType: task.kind,
              legible: true,
              fields: Object.fromEntries(
                Object.entries(values).map(([f, v]) => [
                  f,
                  {
                    value: SENSITIVE_FIELDS.has(f) && v ? maskIban(v) : v,
                    confidence: 'high',
                  },
                ]),
              ),
            }),
            sealed: this.secrets.seal(JSON.stringify(final)),
          },
        },
      );
      await this.sequelize.query(
        `UPDATE "ReviewTask" SET status = 'APPROVED', corrections = CAST(:diff AS jsonb), "resolvedBy" = :reviewerId, "resolvedAt" = now() WHERE id = :taskId`,
        {
          transaction,
          replacements: { taskId, reviewerId, diff: JSON.stringify(diff) },
        },
      );
      await this.sequelize.query(
        `UPDATE "ShopDocument" SET status = 'APPROVED', "updatedAt" = now() WHERE id = :id`,
        { transaction, replacements: { id: task.documentId } },
      );
      for (const field of Object.keys(diff))
        this.corrections.add(1, { kind: task.kind, field });
      return { status: 'APPROVED', shopId: task.shopId, kind: task.kind };
    });

    this.decisions.add(1, { kind: result.kind, decision: result.status });
    const shopVerified =
      result.status === 'APPROVED'
        ? await this.verification.maybeVerify(result.shopId)
        : false;
    return { status: result.status, shopVerified };
  }
}
