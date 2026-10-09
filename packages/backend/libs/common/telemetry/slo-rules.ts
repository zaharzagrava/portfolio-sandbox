/**
 * SLO → Prometheus rules (SD-33 / O-01). Pure, unit-tested; driven by
 * `pnpm slo:generate` over docs/slo/*.yaml.
 *
 * Multi-window, multi-burn-rate alerting (Google SRE workbook ch. 5): a long
 * window proves the burn is significant, a short one proves it is still
 * happening (so the alert resets quickly after a fix).
 *   page   14.4× over 1h AND 5m   → 2% of a 30d budget gone in an hour
 *   page    6×   over 6h AND 30m  → 5% in six hours
 *   ticket  1×   over 3d AND 6h   → on track to spend exactly the budget
 */
export interface SloDefinition {
  name: string;
  journey: string;
  owner: string;
  description: string;
  /** Percent, e.g. 99.95 */
  objective: number;
  window: string;
  sli:
    | { type: 'availability'; metric: string; selector: string }
    /** thresholdSeconds must be an exact histogram bucket boundary of `metric`. */
    | {
        type: 'latency';
        metric: string;
        selector: string;
        thresholdSeconds: number;
      };
  runbook: string;
  k6?: { threshold: string };
}

const WINDOWS = ['5m', '30m', '1h', '6h', '3d'] as const;

export const BURN_ALERTS = [
  { severity: 'page', factor: 14.4, long: '1h', short: '5m', for: '2m' },
  { severity: 'page', factor: 6, long: '6h', short: '30m', for: '15m' },
  { severity: 'ticket', factor: 1, long: '3d', short: '6h', for: '1h' },
] as const;

export function validateSlo(slo: SloDefinition): void {
  if (!/^[a-z0-9-]+$/.test(slo.name))
    throw new Error(`${slo.name}: name must be kebab-case`);
  if (!(slo.objective > 0 && slo.objective < 100))
    throw new Error(`${slo.name}: objective must be in (0, 100)`);
  if (slo.sli.type === 'latency' && !(slo.sli.thresholdSeconds > 0))
    throw new Error(`${slo.name}: latency SLI needs thresholdSeconds`);
}

/** PromQL error ratio of the SLI over `w`. */
export function errorRatio(slo: SloDefinition, w: string): string {
  const { metric, selector } = slo.sli;
  const total = `sum(rate(${metric}_count{${selector}}[${w}]))`;
  if (slo.sli.type === 'availability') {
    return `(sum(rate(${metric}_count{${selector}, http_response_status_code=~"5.."}[${w}])) or vector(0)) / ${total}`;
  }
  const good = `sum(rate(${metric}_bucket{${selector}, le="${slo.sli.thresholdSeconds}"}[${w}]))`;
  return `(${total} - ${good}) / ${total}`;
}

const record = (w: string) => `slo:sli_error:ratio_rate${w}`;

export function sloRuleGroup(slo: SloDefinition) {
  validateSlo(slo);
  const budget = +(1 - slo.objective / 100).toPrecision(6);
  const labels = { slo: slo.name, journey: slo.journey, owner: slo.owner };
  return {
    name: `slo-${slo.name}`,
    rules: [
      ...WINDOWS.map((w) => ({
        record: record(w),
        expr: errorRatio(slo, w),
        labels,
      })),
      { record: 'slo:error_budget:ratio', expr: `vector(${budget})`, labels },
      ...BURN_ALERTS.map((a) => ({
        alert: `SLOBurn_${slo.name.replace(/-/g, '_')}_${a.severity}_${a.long}`,
        expr: `${record(a.long)}{slo="${slo.name}"} > ${+(a.factor * budget).toPrecision(6)} and ${record(a.short)}{slo="${slo.name}"} > ${+(a.factor * budget).toPrecision(6)}`,
        for: a.for,
        labels: { ...labels, severity: a.severity },
        annotations: {
          summary: `${slo.journey}: ${slo.name} burning error budget at ≥${a.factor}× (${a.long}/${a.short})`,
          description: slo.description,
          runbook: slo.runbook,
        },
      })),
    ],
  };
}

/** k6 thresholds keyed by journey - the load tests assert the same targets the alerts guard. */
export function k6Thresholds(slos: SloDefinition[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of slos) if (s.k6) (out[s.journey] ??= []).push(s.k6.threshold);
  return out;
}
