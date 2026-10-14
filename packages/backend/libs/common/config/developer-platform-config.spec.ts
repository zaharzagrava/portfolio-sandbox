import {
  apiKeyPepperRule,
  developerPlatformConfigKeys,
} from './developer-platform-config';
import { ConfigRuleSet } from './config-rules';

const PEPPER = 'a-pepper-of-at-least-thirty-two-bytes-0123';
const OTHER = 'another-secret-of-thirty-two-bytes-0123456';

describe('developer-platform config (S42 AS-21)', () => {
  const pepper = developerPlatformConfigKeys.api_key_pepper.verify;
  const previous = developerPlatformConfigKeys.api_key_pepper_previous.verify;

  it('S42 AS-21: the pepper is required and names its environment variable', () => {
    expect(developerPlatformConfigKeys.api_key_pepper.name).toBe(
      'API_KEY_PEPPER',
    );
    expect(pepper.validate(undefined).error?.message).toMatch(/required/);
    expect(pepper.validate('').error).toBeDefined();
  });

  it('S42 AS-21: a pepper under 32 bytes is refused, 32 bytes or more is accepted', () => {
    expect(pepper.validate('short').error).toBeDefined();
    expect(pepper.validate(PEPPER).error).toBeUndefined();
  });

  it('S42 AS-21: the previous pepper is optional but, when set, has the same length rule', () => {
    expect(previous.validate(undefined).error).toBeUndefined();
    expect(previous.validate('').error).toBeUndefined();
    expect(previous.validate('short').error).toBeDefined();
    expect(previous.validate(PEPPER).error).toBeUndefined();
  });

  const run = (values: Record<string, unknown>) => {
    const ctx = { get: (k: string) => values[k], production: false };
    return apiKeyPepperRule(ctx);
  };

  it('S42 AS-21: the same value as another secret fails startup, naming both keys and never a value', () => {
    const found = run({ api_key_pepper: PEPPER, jwt_secret: PEPPER });
    expect(found).toEqual(['api_key_pepper must differ from jwt_secret']);
    expect(JSON.stringify(found)).not.toContain(PEPPER);
    expect(
      run({ api_key_pepper: PEPPER, ads_click_secret: PEPPER }),
    ).toHaveLength(1);
  });

  it('S42 AS-21: the previous pepper must differ from the current one and from every other secret', () => {
    expect(
      run({ api_key_pepper: PEPPER, api_key_pepper_previous: PEPPER }),
    ).toEqual(['api_key_pepper_previous must differ from api_key_pepper']);
    expect(
      run({
        api_key_pepper: PEPPER,
        api_key_pepper_previous: OTHER,
        jwt_secret: OTHER,
      }),
    ).toEqual(['api_key_pepper_previous must differ from jwt_secret']);
    expect(
      run({ api_key_pepper: PEPPER, api_key_pepper_previous: OTHER }),
    ).toEqual([]);
  });

  it('S42 AS-21: the rule is registered with the shared rule set, owner developer-platform', () => {
    const set = new ConfigRuleSet();
    set.register({
      owner: 'developer-platform',
      keys: [],
      validate: apiKeyPepperRule,
    });
    expect(
      set.validate(
        { api_key_pepper: PEPPER, jwt_secret: PEPPER },
        { production: false },
      ),
    ).toEqual([
      '[developer-platform] api_key_pepper must differ from jwt_secret',
    ]);
  });
});
