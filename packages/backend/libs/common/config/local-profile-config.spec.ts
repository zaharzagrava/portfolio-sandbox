import { localProfileRule, parseList } from './local-profile-config';

const ctx = (values: Record<string, unknown>, production = false) => ({
  get: (key: string) => values[key],
  production,
});

describe('local-profile settings (J02 FR-023)', () => {
  it('S50 G-02: accepts an empty profile, in production too', () => {
    expect(localProfileRule(ctx({}))).toEqual([]);
    expect(localProfileRule(ctx({}, true))).toEqual([]);
  });

  it('S50 G-02: refuses every local-profile setting when running in production', () => {
    const problems = localProfileRule(
      ctx(
        {
          bootstrap_admin_email: 'a@b.test',
          bootstrap_admin_password: 'a-long-bootstrap-password',
          rate_limit_allow_ips: '127.0.0.1',
          allowed_receiver_hosts: '127.0.0.1:9443',
          allowed_receiver_ca_fingerprint: 'ab',
        },
        true,
      ),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'bootstrap_admin_email must not be set in production',
        'bootstrap_admin_password must not be set in production',
        'rate_limit_allow_ips must not be set in production',
        'allowed_receiver_hosts must not be set in production',
        'allowed_receiver_ca_fingerprint must not be set in production',
      ]),
    );
  });

  it('S50 G-02: wants the bootstrap pair together', () => {
    expect(
      localProfileRule(ctx({ bootstrap_admin_email: 'a@b.test' })),
    ).toEqual([
      'bootstrap_admin_email and bootstrap_admin_password must be set together',
    ]);
  });

  it('S50 G-02: wants host:port entries and a hex fingerprint when one is given', () => {
    expect(
      localProfileRule(ctx({ allowed_receiver_hosts: 'localhost' })),
    ).toEqual(
      expect.arrayContaining([
        'allowed_receiver_hosts entries must be host:port',
      ]),
    );
    expect(
      localProfileRule(ctx({ allowed_receiver_hosts: '127.0.0.1:9443' })),
    ).toEqual([]);
    expect(
      localProfileRule(
        ctx({
          allowed_receiver_hosts: '127.0.0.1:9443',
          allowed_receiver_ca_fingerprint: 'not-hex',
        }),
      ),
    ).toEqual([
      'allowed_receiver_ca_fingerprint entries must be hex SHA-256 digests',
    ]);
  });

  it('parses comma lists', () => {
    expect(parseList(' a:1, b:2 ,,')).toEqual(['a:1', 'b:2']);
    expect(parseList(undefined)).toEqual([]);
  });
});
