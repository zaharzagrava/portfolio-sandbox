import {
  apiKeyPepperRule,
  developerPlatformConfigKeys,
  widgetTokenKeyRule,
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

describe('developer-platform config (S44 FR-020, FR-025)', () => {
  const key = developerPlatformConfigKeys.widget_token_key;
  const bundle = developerPlatformConfigKeys.widget_app_bundle_url.verify;

  it('S44 AS-23: the widget token key is required, at least 32 bytes, and names its variable', () => {
    expect(key.name).toBe('WIDGET_TOKEN_KEY');
    expect(key.verify.validate(undefined).error?.message).toMatch(/required/);
    expect(key.verify.validate('short').error).toBeDefined();
    expect(key.verify.validate(PEPPER).error).toBeUndefined();
  });

  it('S44 AS-23: the widget token key must differ from every other secret', () => {
    const run = (values: Record<string, unknown>) =>
      widgetTokenKeyRule({ get: (k: string) => values[k], production: false });
    expect(run({ widget_token_key: PEPPER, jwt_secret: PEPPER })).toEqual([
      'widget_token_key must differ from jwt_secret',
    ]);
    expect(run({ widget_token_key: PEPPER, api_key_pepper: PEPPER })).toEqual([
      'widget_token_key must differ from api_key_pepper',
    ]);
    expect(run({ widget_token_key: PEPPER, jwt_secret: OTHER })).toEqual([]);
  });

  it('S44 AS-34: the bundle address is a path or an HTTPS URL, never plain http', () => {
    expect(bundle.validate(undefined).error).toBeUndefined();
    expect(bundle.validate('/widget/v1/app.js').error).toBeUndefined();
    expect(bundle.validate('https://cdn.example/app.js').error).toBeUndefined();
    expect(bundle.validate('http://cdn.example/app.js').error).toBeDefined();
    expect(bundle.validate('javascript:alert(1)').error).toBeDefined();
  });
});
