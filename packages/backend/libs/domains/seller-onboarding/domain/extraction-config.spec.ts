import {
  EXTRACTION_DEFAULTS,
  resolveExtractionConfig,
} from './extraction-config';

describe('resolveExtractionConfig', () => {
  it('S04 AS-69: defaults are valid and match the spec numbers', () => {
    expect(resolveExtractionConfig({})).toEqual({
      extractionModel: 'claude-haiku-4-5',
      escalationModel: 'claude-opus-5-5',
      nameMatchThreshold: 0.6,
      statementMaxAgeDays: 180,
      modelTimeoutMs: 45_000,
      leaseMs: 300_000,
      maxAttempts: 2,
      linkTtlSeconds: 300,
      grantTtlSeconds: 900,
      rawRetentionDays: 30,
      recordRetentionDays: 1825,
      queueVisibilitySeconds: 270,
    });
    expect(EXTRACTION_DEFAULTS.leaseMs).toBeGreaterThan(
      EXTRACTION_DEFAULTS.modelTimeoutMs,
    );
  });

  it('S04 AS-69: unrelated configuration keys are ignored', () => {
    expect(() =>
      resolveExtractionConfig({ node_env: 'test', jwt_secret: 'x' }),
    ).not.toThrow();
  });

  it('S04 AS-69: valid overrides are applied', () => {
    const c = resolveExtractionConfig({
      onboarding_extraction_model: 'cheap-1',
      onboarding_escalation_model: 'strong-1',
      onboarding_name_match_threshold: 0,
      onboarding_lease_ms: 46_000,
      onboarding_record_retention_days: 365,
    });
    expect(c).toMatchObject({
      extractionModel: 'cheap-1',
      escalationModel: 'strong-1',
      nameMatchThreshold: 0,
      leaseMs: 46_000,
      recordRetentionDays: 365,
    });
  });

  it('S04 AS-69: threshold boundaries 0 and 1 are valid', () => {
    expect(() =>
      resolveExtractionConfig({ onboarding_name_match_threshold: 1 }),
    ).not.toThrow();
  });

  it.each([
    [
      'lease equal to the model timeout',
      { onboarding_lease_ms: 45_000 },
      'onboarding_lease_ms',
    ],
    [
      'lease below the model timeout',
      { onboarding_lease_ms: 1_000 },
      'onboarding_lease_ms',
    ],
    [
      'lease not above a raised timeout',
      {
        onboarding_model_timeout_ms: 400_000,
        onboarding_queue_visibility_seconds: 3_000,
      },
      'onboarding_lease_ms',
    ],
    [
      'threshold below 0',
      { onboarding_name_match_threshold: -0.01 },
      'onboarding_name_match_threshold',
    ],
    [
      'threshold above 1',
      { onboarding_name_match_threshold: 1.01 },
      'onboarding_name_match_threshold',
    ],
    [
      'threshold NaN',
      { onboarding_name_match_threshold: NaN },
      'onboarding_name_match_threshold',
    ],
    [
      'threshold not a number',
      { onboarding_name_match_threshold: 'high' },
      'onboarding_name_match_threshold',
    ],
    ['attempts 1', { onboarding_max_attempts: 1 }, 'onboarding_max_attempts'],
    ['attempts 3', { onboarding_max_attempts: 3 }, 'onboarding_max_attempts'],
    [
      'negative statement age',
      { onboarding_statement_max_age_days: -1 },
      'onboarding_statement_max_age_days',
    ],
    [
      'zero statement age',
      { onboarding_statement_max_age_days: 0 },
      'onboarding_statement_max_age_days',
    ],
    [
      'fractional statement age',
      { onboarding_statement_max_age_days: 1.5 },
      'onboarding_statement_max_age_days',
    ],
    [
      'negative raw retention',
      { onboarding_raw_retention_days: -30 },
      'onboarding_raw_retention_days',
    ],
    [
      'negative record retention',
      { onboarding_record_retention_days: -1 },
      'onboarding_record_retention_days',
    ],
    [
      'zero model timeout',
      { onboarding_model_timeout_ms: 0 },
      'onboarding_model_timeout_ms',
    ],
    [
      'zero link lifetime',
      { onboarding_link_ttl_seconds: 0 },
      'onboarding_link_ttl_seconds',
    ],
    [
      'zero grant lifetime',
      { onboarding_grant_ttl_seconds: 0 },
      'onboarding_grant_ttl_seconds',
    ],
    [
      'empty extraction model',
      { onboarding_extraction_model: '' },
      'onboarding_extraction_model',
    ],
    [
      'blank extraction model',
      { onboarding_extraction_model: '   ' },
      'onboarding_extraction_model',
    ],
    [
      'empty escalation model',
      { onboarding_escalation_model: '' },
      'onboarding_escalation_model',
    ],
    [
      'both models the same',
      {
        onboarding_extraction_model: 'same',
        onboarding_escalation_model: 'same',
      },
      'onboarding_escalation_model',
    ],
    [
      'queue visibility shorter than 6 model timeouts',
      { onboarding_queue_visibility_seconds: 269 },
      'onboarding_queue_visibility_seconds',
    ],
    [
      'queue visibility too short for a raised timeout',
      { onboarding_model_timeout_ms: 60_000 },
      'onboarding_queue_visibility_seconds',
    ],
  ])('S04 AS-69: %s fails naming the key', (_, config, key) => {
    expect(() => resolveExtractionConfig(config)).toThrow(key);
  });

  it('S04 AS-69: queue visibility of exactly 6 model timeouts is valid', () => {
    expect(() =>
      resolveExtractionConfig({ onboarding_queue_visibility_seconds: 270 }),
    ).not.toThrow();
  });

  it('S04 AS-69: every violation is reported together', () => {
    let message = '';
    try {
      resolveExtractionConfig({
        onboarding_max_attempts: 5,
        onboarding_name_match_threshold: 2,
        onboarding_extraction_model: '',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('onboarding_max_attempts');
    expect(message).toContain('onboarding_name_match_threshold');
    expect(message).toContain('onboarding_extraction_model');
  });

  it('S04 AS-69: the message never echoes the offending model name', () => {
    let message = '';
    try {
      resolveExtractionConfig({
        onboarding_extraction_model: 'same-secret-name',
        onboarding_escalation_model: 'same-secret-name',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('onboarding_escalation_model');
    expect(message).not.toContain('same-secret-name');
  });
});
