import { assertLlmConfig, LlmConfigError, llmConfigViolations } from './llm-config';

const VALID: Record<string, unknown> = {
  llm_provider: 'anthropic',
  anthropic_api_key: 'sk-test',
  assistant_model: 'claude-opus-5-5',
  assistant_fallback_model: 'claude-sonnet-5-5',
  assistant_summary_model: 'claude-haiku-4-5',
  assistant_effort: 'low',
  assistant_detach_grace_ms: 10_000,
  assistant_max_active_turns: 3,
  assistant_first_token_timeout_ms: 30_000,
  assistant_call_timeout_ms: 120_000,
  assistant_turn_timeout_ms: 240_000,
  assistant_tool_timeout_ms: 5_000,
  assistant_heartbeat_ms: 15_000,
  assistant_replay_window_ms: 900_000,
  assistant_drain_ms: 25_000,
};

const check = (over: Record<string, unknown>, production = false) =>
  llmConfigViolations((k) => ({ ...VALID, ...over })[k], production);

describe('LLM startup configuration', () => {
  it('S46 AS-74: the valid configuration has no violation, in and out of production', () => {
    expect(check({})).toEqual([]);
    expect(check({}, true)).toEqual([]);
  });

  it.each([
    ['the real provider without an API key', { anthropic_api_key: '' }, false, 'anthropic_api_key'],
    ['the real provider by default without an API key', { llm_provider: undefined, anthropic_api_key: undefined }, false, 'anthropic_api_key'],
    ['the scripted provider in production', { llm_provider: 'scripted' }, true, 'llm_provider'],
    ['an unpriced primary model', { assistant_model: 'claude-unknown-9' }, false, 'assistant_model'],
    ['an unpriced fallback model', { assistant_fallback_model: 'nope' }, false, 'assistant_fallback_model'],
    ['an unpriced summary model', { assistant_summary_model: 'nope' }, false, 'assistant_summary_model'],
    ['a negative limit', { assistant_max_active_turns: -1 }, false, 'assistant_max_active_turns'],
    ['a non-integer timeout', { assistant_call_timeout_ms: 1.5 }, false, 'assistant_call_timeout_ms'],
    ['a heartbeat above 25 s', { assistant_heartbeat_ms: 25_001 }, false, 'assistant_heartbeat_ms'],
    ['a fallback equal to the primary in production', { assistant_fallback_model: 'claude-opus-5-5' }, true, 'assistant_fallback_model'],
    ['a fallback equal to the primary when required', { assistant_fallback_model: 'claude-opus-5-5', assistant_require_distinct_fallback: true }, false, 'assistant_fallback_model'],
  ])('S46 AS-74: %s fails startup naming the key', (_name, over, production, key) => {
    const found = check(over, production);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain(key);
  });

  it('S46 AS-74: the scripted provider is allowed outside production when chosen, and needs no key', () => {
    expect(
      check({ llm_provider: 'scripted', anthropic_api_key: undefined }),
    ).toEqual([]);
  });

  it('S46 AS-74: a fallback equal to the primary is allowed outside production unless required', () => {
    expect(check({ assistant_fallback_model: 'claude-opus-5-5' })).toEqual([]);
    expect(
      check(
        { assistant_fallback_model: 'claude-opus-5-5', assistant_require_distinct_fallback: false },
        true,
      ),
    ).toEqual([]);
  });

  it('S46 AS-74: assertLlmConfig throws one error listing every violation and never a secret value', () => {
    const get = (k: string) =>
      ({
        ...VALID,
        anthropic_api_key: '',
        assistant_model: 'claude-unknown-9',
        assistant_heartbeat_ms: 60_000,
      })[k];

    expect(() => assertLlmConfig(get, false)).toThrow(LlmConfigError);
    try {
      assertLlmConfig(get, false);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('anthropic_api_key');
      expect(message).toContain('assistant_model');
      expect(message).toContain('assistant_heartbeat_ms');
      expect(message).not.toContain('claude-unknown-9');
    }
  });
});
