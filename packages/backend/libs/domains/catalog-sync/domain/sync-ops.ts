import { createHash } from 'node:crypto';
import { syncOpSchema, type SyncOp } from '@marketplace-sandbox/contracts';

export type { SyncOp };

export interface OpIssue {
  /** Dotted path of the failing member; `''` for the operation itself. */
  path: string;
  message: string;
}

export type ParsedOp =
  { ok: true; op: SyncOp } | { ok: false; issues: OpIssue[] };

/** Validates one operation alone, so one malformed operation never fails its batch (FR-007). */
export function parseOp(raw: unknown): ParsedOp {
  const parsed = syncOpSchema.safeParse(raw);
  if (parsed.success) return { ok: true, op: parsed.data };
  const issues: OpIssue[] = [];
  for (const issue of parsed.error.issues.slice(0, 20)) {
    if (issue.code === 'unrecognized_keys')
      for (const key of issue.keys)
        issues.push({
          path: [...issue.path, key].join('.'),
          message: 'unknown field',
        });
    else issues.push({ path: issue.path.join('.'), message: issue.message });
    // A refinement on the `fields` object reports the object itself.
  }
  return { ok: false, issues };
}

/** The operation id of a malformed operation, when it has a usable one (it names the rejected result). */
export function opIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = (raw as { opId?: unknown }).opId;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

/** What the operation asks for, apart from its identity: the part the fingerprint covers and the recovery job replays. */
export function payloadOf(op: SyncOp): Record<string, unknown> {
  switch (op.type) {
    case 'stock.adjust':
      return { delta: op.delta, reason: op.reason };
    case 'stock.count':
      return { counted: op.counted, base: op.base };
    case 'product.update':
      return { fields: op.fields };
  }
}

/** Rebuilds an operation from the stored columns and `content` (the recovery job has no client). */
export function opFromRecord(record: {
  opId: string;
  type: SyncOp['type'];
  productId: string;
  hlc: string;
  content: Record<string, unknown>;
}): SyncOp {
  return {
    type: record.type,
    opId: record.opId,
    hlc: record.hlc,
    productId: record.productId,
    ...record.content,
  } as SyncOp;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
};

/** SHA-256 over the canonical JSON of `{type, productId, hlc, payload}` (R-02); the device is not part of it. */
export function fingerprint(op: SyncOp): string {
  return createHash('sha256')
    .update(
      canonical({
        type: op.type,
        productId: op.productId,
        hlc: op.hlc,
        payload: payloadOf(op),
      }),
    )
    .digest('hex');
}
