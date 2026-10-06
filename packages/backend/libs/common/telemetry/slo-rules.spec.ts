import { errorRatio, k6Thresholds, sloRuleGroup, SloDefinition } from './slo-rules';

const checkout: SloDefinition = {
  name: 'checkout-availability',
  journey: 'Checkout',
  owner: 'commerce',
  description: 'Checkout succeeds',
  objective: 99.95,
  window: '30d',
  sli: { type: 'availability', metric: 'http_server_request_duration_seconds', selector: 'service="core"' },
  runbook: 'docs/runbooks/APIErrorBudgetFastBurn.md',
  k6: { threshold: 'http_req_failed{journey:checkout}: rate<0.0005' },
};

describe('SLO rule generation', () => {
  it('availability SLI = 5xx / all requests, with "no errors" counted as 0', () => {
    expect(errorRatio(checkout, '5m')).toBe(
      '(sum(rate(http_server_request_duration_seconds_count{service="core", http_response_status_code=~"5.."}[5m])) or vector(0)) / sum(rate(http_server_request_duration_seconds_count{service="core"}[5m]))',
    );
  });

  it('latency SLI = requests slower than the threshold bucket / all requests', () => {
    const slo: SloDefinition = { ...checkout, sli: { type: 'latency', metric: 'm', selector: 'a="b"', thresholdSeconds: 0.3 } };
    expect(errorRatio(slo, '1h')).toBe('(sum(rate(m_count{a="b"}[1h])) - sum(rate(m_bucket{a="b", le="0.3"}[1h]))) / sum(rate(m_count{a="b"}[1h]))');
  });

  it('emits recording rules per window and the three multi-window burn-rate alerts with budget-scaled thresholds', () => {
    const group = sloRuleGroup(checkout);
    expect(group.rules.filter((r) => 'record' in r).map((r) => (r as { record: string }).record)).toEqual([
      'slo:sli_error:ratio_rate5m',
      'slo:sli_error:ratio_rate30m',
      'slo:sli_error:ratio_rate1h',
      'slo:sli_error:ratio_rate6h',
      'slo:sli_error:ratio_rate3d',
      'slo:error_budget:ratio',
    ]);
    const alerts = group.rules.filter((r) => 'alert' in r) as { alert: string; expr: string; labels: { severity: string } }[];
    // budget = 0.0005 → 14.4× = 0.0072, 6× = 0.003, 1× = 0.0005
    expect(alerts.map((a) => [a.labels.severity, a.expr])).toEqual([
      ['page', 'slo:sli_error:ratio_rate1h{slo="checkout-availability"} > 0.0072 and slo:sli_error:ratio_rate5m{slo="checkout-availability"} > 0.0072'],
      ['page', 'slo:sli_error:ratio_rate6h{slo="checkout-availability"} > 0.003 and slo:sli_error:ratio_rate30m{slo="checkout-availability"} > 0.003'],
      ['ticket', 'slo:sli_error:ratio_rate3d{slo="checkout-availability"} > 0.0005 and slo:sli_error:ratio_rate6h{slo="checkout-availability"} > 0.0005'],
    ]);
  });

  it('rejects malformed definitions', () => {
    expect(() => sloRuleGroup({ ...checkout, objective: 100 })).toThrow(/objective/);
    expect(() => sloRuleGroup({ ...checkout, name: 'Bad Name' })).toThrow(/kebab/);
  });

  it('collects k6 thresholds per journey', () => {
    expect(k6Thresholds([checkout, { ...checkout, k6: undefined }])).toEqual({ Checkout: ['http_req_failed{journey:checkout}: rate<0.0005'] });
  });
});
