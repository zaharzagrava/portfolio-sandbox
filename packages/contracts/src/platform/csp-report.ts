import { z } from 'zod';

/**
 * Content Security Policy violation reports as browsers send them to `POST /api/csp-reports` (W07, S54 platform toolkit).
 * Deliberately lenient: browsers differ, extensions add noise, and the endpoint must never reject a report.
 *
 * - `application/csp-report`: `{ "csp-report": { "violated-directive", "effective-directive", "blocked-uri", ... } }`
 * - `application/reports+json` (Reporting API): `[{ "type": "csp-violation", "body": { "effectiveDirective", "blockedURL", ... } }]`
 */
const text = z.string().optional().catch(undefined);

export const legacyCspReportSchema = z.object({
  'csp-report': z
    .object({
      'violated-directive': text,
      'effective-directive': text,
      'blocked-uri': text,
    })
    .loose(),
});

export const reportingApiEntrySchema = z.object({
  type: z.string().optional().catch(undefined),
  body: z
    .object({
      effectiveDirective: text,
      violatedDirective: text,
      blockedURL: text,
    })
    .loose()
    .optional()
    .catch(undefined),
});

export const cspReportBodySchema = z.union([legacyCspReportSchema, reportingApiEntrySchema, z.array(reportingApiEntrySchema)]);
export type CspReportBody = z.infer<typeof cspReportBodySchema>;

/** The two facts operators need from a violation. Nothing else (no document address, no query) is kept. */
export type CspViolation = { directive: string; blockedHost: string };

const DIRECTIVE = /^[a-z][a-z0-9-]{0,39}$/;
const KEYWORDS = new Set(['inline', 'eval', 'data', 'blob', 'self', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink']);

/** `https://cdn.example.com/a.js?token=1` -> `https://cdn.example.com`; keywords pass through; anything else is `unknown`. */
export function blockedHostOf(value: string | undefined): string {
  if (!value) return 'unknown';
  const lower = value.toLowerCase();
  if (KEYWORDS.has(lower)) return lower;
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol.slice(0, -1);
    return url.host ? `${url.protocol}//${url.host}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Violations found in an arbitrary parsed body; `[]` for anything that is not a report. Never throws. */
export function cspViolationsFrom(raw: unknown): CspViolation[] {
  const parsed = cspReportBodySchema.safeParse(raw);
  if (!parsed.success) return [];
  const data = parsed.data;
  const violations: CspViolation[] = [];
  const add = (directive: string | undefined, blocked: string | undefined) => {
    const name = directive?.split(/\s+/)[0]?.toLowerCase();
    violations.push({ directive: name && DIRECTIVE.test(name) ? name : 'unknown', blockedHost: blockedHostOf(blocked) });
  };
  if (Array.isArray(data)) {
    for (const entry of data) if (entry.type === 'csp-violation') add(entry.body?.effectiveDirective ?? entry.body?.violatedDirective, entry.body?.blockedURL);
  } else if ('csp-report' in data) {
    const body = data['csp-report'];
    add(body['effective-directive'] ?? body['violated-directive'], body['blocked-uri']);
  } else if (data.type === 'csp-violation') {
    add(data.body?.effectiveDirective ?? data.body?.violatedDirective, data.body?.blockedURL);
  }
  return violations.slice(0, 20);
}
