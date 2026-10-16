import { EXTRACTION_DEFAULTS } from './extraction-config';
import {
  type Extraction,
  FIELDS,
  extractionZod,
} from './extraction-schema';
import type { Answers, DocumentKind } from './questionnaire';
import {
  isValidIban,
  isValidVat,
  namesMatch,
  normalizeVat,
} from './validators';

/**
 * The business rules applied to a model answer (S04 AS-23, FR-022). Pure: the clock is passed in, nothing is read
 * from the environment. Rules, not the model's confidence, decide whether a value is acceptable.
 */
export interface Issue {
  field: string | null;
  code: string;
  /** true = a stronger model reading the document again could plausibly fix it. */
  escalate: boolean;
}

export type ExtractionOutcome = 'ACCEPTED' | 'ESCALATE' | 'REVIEW';

/** The model's answer as the rules see it: a refusal flag and the text of the answer. */
export interface ModelOutput {
  refused: boolean;
  text: string;
}

export interface RuleConfig {
  nameMatchThreshold: number;
  statementMaxAgeDays: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  nameMatchThreshold: EXTRACTION_DEFAULTS.nameMatchThreshold,
  statementMaxAgeDays: EXTRACTION_DEFAULTS.statementMaxAgeDays,
};

const DAY_MS = 86_400_000;

/** UTC calendar day number of a printed date, or `null` when it cannot be read. */
const dayOf = (printed: string): number | null => {
  const ms = Date.parse(printed);
  return Number.isNaN(ms) ? null : Math.floor(ms / DAY_MS);
};

const compact = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const stripPrefix = (vat: string) => vat.replace(/^[A-Z]{2}/, '');

/** Model output → strict schema → rules. */
export function evaluateExtraction(
  kind: DocumentKind,
  output: ModelOutput,
  answers: Answers | null,
  now: Date,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): { extraction: Extraction | null; issues: Issue[] } {
  if (output.refused)
    return {
      extraction: null,
      issues: [{ field: null, code: 'model_refused', escalate: false }],
    };
  let extraction: Extraction;
  try {
    extraction = extractionZod(kind).parse(JSON.parse(output.text));
  } catch {
    return {
      extraction: null,
      issues: [{ field: null, code: 'invalid_output', escalate: true }],
    };
  }

  const issues: Issue[] = [];
  const add = (field: string | null, code: string, escalate: boolean) =>
    issues.push({ field, code, escalate });
  const v = (f: string) => extraction.fields[f]?.value ?? null;
  const today = Math.floor(now.getTime() / DAY_MS);

  if (!extraction.legible) add(null, 'illegible', false);
  if (extraction.documentType !== kind) add(null, 'wrong_document_type', true);
  for (const f of FIELDS[kind]) {
    const fv = extraction.fields[f];
    if (!fv?.value || fv.confidence === 'low')
      add(f, 'missing_or_low_confidence', true);
  }

  const business = answers?.business;
  const nameField = kind === 'BANK_STATEMENT' ? 'accountHolder' : 'legalName';
  const name = v(nameField);
  if (
    name &&
    business &&
    !namesMatch(name, business.businessName, config.nameMatchThreshold)
  )
    add(nameField, 'name_mismatch', false);

  switch (kind) {
    case 'BUSINESS_REGISTRATION': {
      const country = v('country');
      if (country && business && country.toUpperCase() !== business.country)
        add('country', 'country_mismatch', false);
      const reg = v('registrationNumber');
      if (
        reg &&
        business &&
        compact(reg) !== compact(business.registrationNumber)
      )
        add('registrationNumber', 'registration_number_mismatch', true);
      const issued = v('issueDate');
      if (issued) {
        const day = dayOf(issued);
        if (day === null || day > today) add('issueDate', 'invalid_date', true);
      }
      break;
    }
    case 'VAT_CERTIFICATE': {
      const vat = v('vatNumber');
      const country = v('country') ?? business?.country ?? '';
      if (vat && !isValidVat(country.toUpperCase(), vat))
        add('vatNumber', 'vat_checksum', true);
      const declared = answers?.tax.vatNumber;
      if (
        vat &&
        declared &&
        stripPrefix(normalizeVat(vat)) !== stripPrefix(normalizeVat(declared))
      )
        add('vatNumber', 'vat_mismatch', true);
      break;
    }
    case 'BANK_STATEMENT': {
      const iban = v('iban');
      if (iban && !isValidIban(iban)) add('iban', 'iban_checksum', true);
      const printed = v('statementDate');
      if (printed) {
        // Whole UTC days: day 180 passes, day 181 and any future date fail.
        const day = dayOf(printed);
        const age = day === null ? null : today - day;
        if (age === null || age < 0 || age > config.statementMaxAgeDays)
          add('statementDate', 'statement_too_old', false);
      }
      break;
    }
  }
  return { extraction, issues };
}

export const needsEscalation = (issues: readonly Issue[]) =>
  issues.some((i) => i.escalate);

/**
 * What happens after attempt `attempt` (1-based) of at most `maxAttempts`: no issue accepts; an escalating issue
 * with an attempt left reads again with the stronger model; anything else goes to a human.
 */
export function outcomeFor(
  issues: readonly Issue[],
  attempt: number,
  maxAttempts: number,
): ExtractionOutcome {
  if (!issues.length) return 'ACCEPTED';
  return attempt < maxAttempts && needsEscalation(issues)
    ? 'ESCALATE'
    : 'REVIEW';
}
