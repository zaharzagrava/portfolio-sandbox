import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type KycName =
  | 'kyc-ok-registration'
  | 'kyc-ok-bank'
  | 'kyc-ok-vat'
  | 'kyc-unclear'
  | 'kyc-forged';

export interface KycFixture {
  name: KycName;
  path: string;
  /** Document kind the seller declares when asking for the upload. */
  kind: 'BUSINESS_REGISTRATION' | 'BANK_STATEMENT' | 'VAT_CERTIFICATE';
  sha256: string;
  size: number;
  contentType: 'application/pdf';
}

const KINDS: Record<KycName, KycFixture['kind']> = {
  'kyc-ok-registration': 'BUSINESS_REGISTRATION',
  'kyc-ok-bank': 'BANK_STATEMENT',
  'kyc-ok-vat': 'VAT_CERTIFICATE',
  'kyc-unclear': 'BUSINESS_REGISTRATION',
  'kyc-forged': 'BUSINESS_REGISTRATION',
};

const DIR = join(__dirname, 'fixtures');

/**
 * The five KYC documents. Each carries the model double's `%SCRIPTED-REPLY:` marker (the reply the extractor "reads" from
 * it), so the stack passes extraction without a real model (`PROVIDER_DOUBLES=enabled`). The recorded `sha256` is of the
 * file on disk.
 */
export const kycFixtures = Object.fromEntries(
  (Object.keys(KINDS) as KycName[]).map((name) => {
    const path = join(DIR, `${name}.pdf`);
    const bytes = readFileSync(path);
    return [
      name,
      {
        name,
        path,
        kind: KINDS[name],
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        contentType: 'application/pdf',
      } satisfies KycFixture,
    ];
  }),
) as Record<KycName, KycFixture>;

export const kycBytes = (fixture: KycFixture): Buffer =>
  readFileSync(fixture.path);

export interface KycOverrides {
  /** Replaces field values in the scripted reply (by field name), e.g. a unique `iban` or a recent `statementDate`. */
  fields?: Record<string, string>;
}

/**
 * The fixture's bytes made unique to one shop: the same marker line (with the overridden fields), then a trailer line the
 * marker parser ignores. Cross-shop rules (the same IBAN, the same file hash) therefore never fire between journey runs,
 * and a bank statement stays recent however old the checked-in file gets.
 */
export function kycVariant(
  fixture: KycFixture,
  overrides: KycOverrides = {},
): Buffer {
  const text = readFileSync(fixture.path).toString('latin1');
  const marker = '%SCRIPTED-REPLY:';
  const at = text.indexOf(marker);
  const head = text.slice(0, at);
  const reply = JSON.parse(text.slice(at + marker.length).split(/\r?\n/, 1)[0]);
  for (const [field, value] of Object.entries(overrides.fields ?? {}))
    if (reply.fields?.[field])
      reply.fields[field] = { ...reply.fields[field], value, evidence: value };
  return Buffer.from(
    `${head}${marker}${JSON.stringify(reply)}\n%UNIQUE:${randomUUID()}\n`,
    'latin1',
  );
}
