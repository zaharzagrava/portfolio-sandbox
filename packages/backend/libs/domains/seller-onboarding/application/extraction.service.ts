import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type Anthropic from '@anthropic-ai/sdk';
import { metrics } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { SecretBox } from '@app/domains/identity';
import { LLM_PROVIDER, LlmTurnResult, textOf, LlmMeter } from '@app/domains/assistant';
import type { LlmProvider } from '@app/domains/assistant';
import { Answers, DocumentKind } from '../domain/questionnaire';
import { EXTRACTION_SYSTEM, Extraction, extractionZod, FIELDS, jsonSchemaFor, PROMPT_VERSION, SENSITIVE_FIELDS } from '../domain/extraction-schema';
import { isValidIban, isValidVat, maskIban, namesMatch, normalizeVat } from '../domain/validators';
import { ShopDocumentRow } from './onboarding-documents.service';
import { VerificationService } from './verification.service';

export interface Issue {
  field: string | null;
  code: string;
  /** true = a stronger model reading the document again could plausibly fix it. */
  escalate: boolean;
}

type Outcome = 'ACCEPTED' | 'ESCALATE' | 'REVIEW';

const STATEMENT_MAX_AGE_DAYS = 180;
const MAX_ATTEMPTS = 2;

/**
 * KYC extraction (SD-44, 10/10 #44):
 *  1. cheap model first, structured outputs (JSON schema, constrained) with
 *     a value + confidence + evidence per field,
 *  2. zod re-validation + business rules (IBAN mod-97, VAT checksum, names
 *     and numbers cross-checked against the questionnaire, dates),
 *  3. a failure a better reader could fix → ONE escalation to the strong
 *     model; anything still failing → human review queue.
 * The model has no tools, and the document is declared as data in the
 * prompt; its output is never trusted - rules decide, not confidence.
 * Every attempt is stored (masked + sealed), so redelivery resumes where it
 * stopped and reviewers see what each model read.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly outcomes = metrics.getMeter('onboarding').createCounter('kyc_extraction_outcomes_total');

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly meter: LlmMeter,
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretBox,
    private readonly verification: VerificationService,
    private readonly config: ApiConfigService,
  ) {}

  private modelFor(attempt: number) {
    return attempt === 1 ? (this.config.get('onboarding_extraction_model') ?? 'claude-haiku-4-5') : (this.config.get('onboarding_escalation_model') ?? 'claude-opus-5-5');
  }

  /** SQS/Lambda handler body. Provider errors propagate (SQS retries, then DLQ); everything else ends in APPROVED or NEEDS_REVIEW. */
  async process(documentId: string): Promise<void> {
    const [doc] = await this.sequelize.query<ShopDocumentRow>(
      `UPDATE "ShopDocument" SET status = 'EXTRACTING', "updatedAt" = now() WHERE id = :documentId AND status IN ('QUEUED', 'EXTRACTING') RETURNING *`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    if (!doc) return; // already decided, superseded, or not uploaded

    const [onboarding] = await this.sequelize.query<{ answers: Answers }>(`SELECT answers FROM "ShopOnboarding" WHERE "shopId" = :shopId`, {
      type: QueryTypes.SELECT,
      replacements: { shopId: doc.shopId },
    });

    const previous = await this.sequelize.query<{ attempt: number; outcome: Outcome; issues: Issue[] }>(
      `SELECT attempt, outcome, issues FROM "DocumentExtraction" WHERE "documentId" = :documentId ORDER BY attempt`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    let last = previous.at(-1);

    const bytes = last && last.outcome !== 'ESCALATE' ? null : await this.read(doc);
    const sniffed = bytes ? sniff(bytes) : doc.contentType;
    if (bytes && sniffed !== doc.contentType) {
      return this.finish(doc, 'REVIEW', [{ field: null, code: 'content_type_mismatch', escalate: false }]);
    }

    for (let attempt = (last?.attempt ?? 0) + 1; attempt <= MAX_ATTEMPTS && (!last || last.outcome === 'ESCALATE'); attempt++) {
      const model = this.modelFor(attempt);
      const started = Date.now();
      const result = await this.llm.complete({
        model,
        system: [{ type: 'text', text: EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [],
        messages: [{ role: 'user', content: [documentBlock(doc.contentType, bytes!), { type: 'text', text: `This was uploaded as: ${doc.kind}. Extract the fields.` }] }],
        maxTokens: 2_000,
        effort: 'low',
        outputSchema: jsonSchemaFor(doc.kind),
      });
      void this.meter
        .record({ subjectId: doc.shopId, scopeId: doc.id, callId: `${doc.id}:${attempt}`, purpose: 'extraction', requestedModel: model, result, ttftMs: null, durationMs: Date.now() - started })
        .catch(() => undefined);

      const { extraction, issues } = this.evaluate(doc.kind, result, onboarding?.answers ?? null);
      const outcome: Outcome = !issues.length ? 'ACCEPTED' : attempt < MAX_ATTEMPTS && issues.some((i) => i.escalate) ? 'ESCALATE' : 'REVIEW';
      await this.sequelize.query(
        `INSERT INTO "DocumentExtraction" ("documentId", attempt, model, "promptVersion", fields, "sealedFields", issues, outcome, "inputTokens", "outputTokens")
         VALUES (:documentId, :attempt, :model, :promptVersion, CAST(:fields AS jsonb), :sealed, CAST(:issues AS jsonb), :outcome, :inputTokens, :outputTokens)
         ON CONFLICT ("documentId", attempt) DO NOTHING`,
        {
          replacements: {
            documentId: doc.id,
            attempt,
            model: result.model,
            promptVersion: PROMPT_VERSION,
            fields: JSON.stringify(extraction ? masked(extraction) : {}),
            sealed: this.secrets.seal(JSON.stringify(extraction ?? null)),
            issues: JSON.stringify(issues),
            outcome,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        },
      );
      this.outcomes.add(1, { kind: doc.kind, attempt, outcome });
      last = { attempt, outcome, issues };
    }

    await this.finish(doc, last!.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'REVIEW', last!.issues);
  }

  /** Model output → zod → rules. Pure apart from `now`; exported behaviour is covered by the e2e spec. */
  evaluate(kind: DocumentKind, result: LlmTurnResult, answers: Answers | null): { extraction: Extraction | null; issues: Issue[] } {
    if (result.stopReason === 'refusal') return { extraction: null, issues: [{ field: null, code: 'model_refused', escalate: false }] };
    let extraction: Extraction;
    try {
      extraction = extractionZod(kind).parse(JSON.parse(textOf(result.content)));
    } catch {
      return { extraction: null, issues: [{ field: null, code: 'invalid_output', escalate: true }] };
    }

    const issues: Issue[] = [];
    const add = (field: string | null, code: string, escalate: boolean) => issues.push({ field, code, escalate });
    const v = (f: string) => extraction.fields[f]?.value ?? null;

    if (!extraction.legible) add(null, 'illegible', false);
    if (extraction.documentType !== kind) add(null, 'wrong_document_type', true);
    for (const f of FIELDS[kind]) {
      const fv = extraction.fields[f];
      if (!fv?.value || fv.confidence === 'low') add(f, 'missing_or_low_confidence', true);
    }

    const business = answers?.business;
    const nameField = kind === 'BANK_STATEMENT' ? 'accountHolder' : 'legalName';
    const name = v(nameField);
    if (name && business && !namesMatch(name, business.businessName)) add(nameField, 'name_mismatch', false);

    switch (kind) {
      case 'BUSINESS_REGISTRATION': {
        const country = v('country');
        if (country && business && country.toUpperCase() !== business.country) add('country', 'country_mismatch', false);
        const reg = v('registrationNumber');
        if (reg && business && compact(reg) !== compact(business.registrationNumber)) add('registrationNumber', 'registration_number_mismatch', true);
        const issued = v('issueDate');
        if (issued && !(Date.parse(issued) <= Date.now())) add('issueDate', 'invalid_date', true);
        break;
      }
      case 'VAT_CERTIFICATE': {
        const vat = v('vatNumber');
        const country = v('country') ?? business?.country ?? '';
        if (vat && !isValidVat(country.toUpperCase(), vat)) add('vatNumber', 'vat_checksum', true);
        const declared = answers?.tax.vatNumber;
        if (vat && declared && stripPrefix(normalizeVat(vat)) !== stripPrefix(normalizeVat(declared))) add('vatNumber', 'vat_mismatch', true);
        break;
      }
      case 'BANK_STATEMENT': {
        const iban = v('iban');
        if (iban && !isValidIban(iban)) add('iban', 'iban_checksum', true);
        const date = v('statementDate');
        if (date) {
          const age = (Date.now() - Date.parse(date)) / 86_400_000;
          if (!(age >= 0 && age <= STATEMENT_MAX_AGE_DAYS)) add('statementDate', 'statement_too_old', false);
        }
        break;
      }
    }
    return { extraction, issues };
  }

  private async finish(doc: ShopDocumentRow, outcome: 'ACCEPTED' | 'REVIEW', issues: Issue[]) {
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(`UPDATE "ShopDocument" SET status = :status, "updatedAt" = now() WHERE id = :id AND status = 'EXTRACTING'`, {
        transaction,
        replacements: { id: doc.id, status: outcome === 'ACCEPTED' ? 'APPROVED' : 'NEEDS_REVIEW' },
      });
      if (outcome === 'REVIEW') {
        await this.sequelize.query(
          `INSERT INTO "ReviewTask" ("documentId", "shopId", reasons) VALUES (:documentId, :shopId, CAST(:reasons AS jsonb))
           ON CONFLICT ("documentId") WHERE status = 'OPEN' DO NOTHING`,
          { transaction, replacements: { documentId: doc.id, shopId: doc.shopId, reasons: JSON.stringify(issues) } },
        );
      }
    });
    if (outcome === 'ACCEPTED') await this.verification.maybeVerify(doc.shopId);
  }

  private async read(doc: ShopDocumentRow): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of await this.storage.getStream(doc.storageKey)) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }
}

/** Trust the bytes, not the declared content type. */
export function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function documentBlock(contentType: string, bytes: Buffer): Anthropic.Beta.BetaContentBlockParam {
  const data = bytes.toString('base64');
  return contentType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: contentType as 'image/jpeg' | 'image/png' | 'image/webp', data } };
}

/** Loggable/displayable view: sensitive values masked, evidence dropped (it quotes the sensitive value). */
function masked(extraction: Extraction) {
  return {
    documentType: extraction.documentType,
    legible: extraction.legible,
    fields: Object.fromEntries(
      Object.entries(extraction.fields).map(([f, fv]) => [f, { value: fv.value && SENSITIVE_FIELDS.has(f) ? maskIban(fv.value) : fv.value, confidence: fv.confidence }]),
    ),
  };
}

const compact = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const stripPrefix = (vat: string) => vat.replace(/^[A-Z]{2}/, '');
