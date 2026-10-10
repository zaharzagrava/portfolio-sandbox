import { ConfigRuleSet, platformRules } from './config-rules';

const found = (values: Record<string, unknown>): string[] => {
  const set = new ConfigRuleSet();
  platformRules.forEach((rule) => set.register(rule));
  return set.validate(values, { production: false });
};

describe('S02 B18: Google sign-in configuration', () => {
  it('accepts no Google configuration at all', () => {
    expect(found({})).toEqual([]);
  });

  it('accepts a complete https configuration', () => {
    expect(
      found({
        google_oidc_client_id: 'id',
        google_oidc_client_secret: 'secret-value',
        auth_redirect_base_url: 'https://api.example.com',
      }),
    ).toEqual([]);
  });

  it.each([
    [
      {
        google_oidc_client_id: 'id',
        auth_redirect_base_url: 'https://a.example',
      },
    ],
    [
      {
        google_oidc_client_secret: 'secret-value',
        auth_redirect_base_url: 'https://a.example',
      },
    ],
  ])(
    'refuses a client id without its secret (and the reverse): %j',
    (values) => {
      expect(found(values).join(';')).toMatch(
        /google_oidc_client_id, google_oidc_client_secret must be set together/,
      );
    },
  );

  it('refuses a redirect base that is not https, except on localhost', () => {
    const base = {
      google_oidc_client_id: 'id',
      google_oidc_client_secret: 'secret-value',
    };
    expect(
      found({ ...base, auth_redirect_base_url: 'http://api.example.com' }).join(
        ';',
      ),
    ).toMatch(/auth_redirect_base_url must use https/);
    expect(
      found({ ...base, auth_redirect_base_url: 'http://localhost:8400' }),
    ).toEqual([]);
  });

  it('requires the redirect base when Google is configured (no fall-back to the backend host)', () => {
    expect(
      found({
        google_oidc_client_id: 'id',
        google_oidc_client_secret: 'secret-value',
        backend_host: 'http://api.example.com',
      }).join(';'),
    ).toMatch(/auth_redirect_base_url is required/);
  });

  it('never prints a value', () => {
    expect(
      found({
        google_oidc_client_id: 'super-secret-id',
        auth_redirect_base_url: 'http://api.example.com/secret-path',
      }).join(';'),
    ).not.toMatch(/super-secret-id|secret-path/);
  });
});
