import {
  ConfigRuleSet,
  PlatformSettings,
  RuleCheck,
  distinctSecrets,
  httpsUrl,
  minSecretLength,
  originsDiffer,
  platformRules,
  requireTogether,
} from './config-rules';

const check = (
  rule: RuleCheck,
  values: Record<string, unknown>,
  production = false,
): string[] => {
  const set = new ConfigRuleSet();
  set.register({ owner: 'spec', keys: Object.keys(values), validate: rule });
  return set.validate(values, { production });
};
const platform = (
  values: Record<string, unknown>,
  production = false,
): string[] => {
  const set = new ConfigRuleSet();
  platformRules.forEach((rule) => set.register(rule));
  return set.validate(values, { production });
};

describe('S54 configuration rules (U-CFG)', () => {
  describe('AS-142 capability rules', () => {
    it.each([
      [{ client_id: 'id', client_secret: undefined }, true],
      [{ client_id: undefined, client_secret: 'secret-value' }, true],
      [{ client_id: 'id', client_secret: '' }, true],
      [{ client_id: 'id', client_secret: 'secret-value' }, false],
      [{ client_id: undefined, client_secret: undefined }, false],
    ])('requireTogether %j violates: %s', (values, violates) => {
      const found = check(
        requireTogether(['client_id', 'client_secret']),
        values,
      );
      expect(found.length > 0).toBe(violates);
      found.forEach((line) => expect(line).toMatch(/client_id/));
    });

    it.each([
      ['http://example.com/cb', false, true],
      ['https://example.com/cb', false, false],
      ['http://localhost:3000/cb', true, false],
      ['http://localhost:3000/cb', false, true],
      ['http://127.0.0.1:3000/cb', true, false],
      ['not a url', true, true],
      ['ftp://example.com', true, true],
      ['', true, false],
      [undefined, true, false],
    ])(
      'httpsUrl(%j, allowLocalhost %s) violates: %s',
      (value, allowLocalhost, violates) => {
        const found = check(httpsUrl('redirect_base', { allowLocalhost }), {
          redirect_base: value,
        });
        expect(found.length > 0).toBe(violates);
        found.forEach((line) => {
          expect(line).toMatch(/redirect_base/);
          if (typeof value === 'string' && value)
            expect(line).not.toContain(value);
        });
      },
    );

    it('originsDiffer: the usercontent origin must not equal the app origin in production', () => {
      const rule = originsDiffer('usercontent_origin', 'front_host');
      expect(
        check(
          rule,
          {
            usercontent_origin: 'https://app.example',
            front_host: 'https://app.example/',
          },
          true,
        ),
      ).toHaveLength(1);
      expect(
        check(
          rule,
          {
            usercontent_origin: 'https://usercontent.example',
            front_host: 'https://app.example',
          },
          true,
        ),
      ).toHaveLength(0);
      expect(
        check(
          rule,
          {
            usercontent_origin: 'https://app.example',
            front_host: 'https://app.example',
          },
          false,
        ),
      ).toHaveLength(0);
    });

    it('distinctSecrets: identical values are reported by key name, never by value', () => {
      const found = check(
        distinctSecrets(['a_secret', 'b_secret', 'c_secret']),
        {
          a_secret: 'same-value-xyz',
          b_secret: 'same-value-xyz',
          c_secret: 'other',
        },
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/a_secret/);
      expect(found[0]).toMatch(/b_secret/);
      expect(found[0]).not.toContain('same-value-xyz');
      expect(
        check(distinctSecrets(['a_secret', 'b_secret']), {
          a_secret: 'one',
          b_secret: 'two',
        }),
      ).toHaveLength(0);
    });

    it.each([
      ['x'.repeat(31), true, 1],
      ['x'.repeat(32), true, 0],
      ['x'.repeat(31), false, 0],
      [undefined, true, 0],
    ])(
      'minSecretLength: a %j-length secret in production=%s gives %d violations',
      (value, production, expected) => {
        expect(
          check(
            minSecretLength('signing_secret', 32),
            { signing_secret: value },
            production,
          ),
        ).toHaveLength(expected);
      },
    );
  });

  describe('AS-143 platform settings', () => {
    it.each(['usd', 'US', 'USDX', '12A', ''])(
      'platform_currency %j is rejected',
      (currency) => {
        expect(platform({ platform_currency: currency }).join(' ')).toMatch(
          /platform_currency/,
        );
      },
    );

    it('accepts EUR and exposes it, the app origin and the usercontent origin through PlatformSettings', () => {
      expect(platform({ platform_currency: 'EUR' })).toEqual([]);
      const settings = new PlatformSettings({
        get: (key: string) =>
          ({
            platform_currency: 'EUR',
            front_host: 'https://app.example/shop',
            usercontent_origin: 'https://usercontent.example',
          })[key],
      });
      expect(settings.currency).toBe('EUR');
      expect(settings.appOrigin).toBe('https://app.example');
      expect(settings.usercontentOrigin).toBe('https://usercontent.example');
    });

    it('defaults to USD outside production and is required in production', () => {
      expect(new PlatformSettings({ get: () => undefined }).currency).toBe(
        'USD',
      );
      expect(platform({}, true).join(' ')).toMatch(/platform_currency/);
    });
  });

  describe('AS-144 pool arithmetic', () => {
    it('fails with 20 x 10 = 200 > 150 and passes with 7 instances', () => {
      const failing = platform({
        db_pool_max: 20,
        db_max_instances: 10,
        db_connection_limit: 150,
      });
      expect(failing.join(' ')).toContain('20 × 10 = 200 > 150');
      expect(
        platform({
          db_pool_max: 20,
          db_max_instances: 7,
          db_connection_limit: 150,
        }),
      ).toEqual([]);
    });

    it('subtracts the reserved connections and counts the replica pool', () => {
      expect(
        platform({
          db_pool_max: 10,
          db_max_instances: 10,
          db_connection_limit: 105,
          db_reserved_connections: 10,
        }).join(' '),
      ).toContain('db_pool_max');
      expect(
        platform({
          db_pool_max: 10,
          db_max_instances: 10,
          db_connection_limit: 110,
          db_reserved_connections: 10,
        }),
      ).toEqual([]);
      expect(
        platform({
          db_pool_max: 10,
          db_replica_pool_max: 5,
          db_max_instances: 10,
          db_connection_limit: 140,
        }).join(' '),
      ).toContain('150 > 140');
    });

    it('is not evaluated when the capacity keys are absent', () => {
      expect(platform({ db_pool_max: 50 })).toEqual([]);
    });
  });

  describe('AS-137 and AS-135 production requirements', () => {
    it('production without trusted_proxies fails; "none" and a list start', () => {
      expect(
        platform(
          {
            platform_currency: 'USD',
            cors_allowed_origins: 'https://app.example',
          },
          true,
        ).join(' '),
      ).toMatch(/trusted_proxies/);
      expect(
        platform(
          {
            platform_currency: 'USD',
            cors_allowed_origins: 'https://app.example',
            trusted_proxies: 'none',
          },
          true,
        ),
      ).toEqual([]);
    });

    it.each(['', undefined, '*', 'https://a.example,*'])(
      'production with cors_allowed_origins %j fails',
      (origins) => {
        expect(
          platform(
            {
              platform_currency: 'USD',
              trusted_proxies: 'none',
              cors_allowed_origins: origins,
            },
            true,
          ).join(' '),
        ).toMatch(/cors_allowed_origins/);
      },
    );

    it('outside production an empty allowlist is fine', () => {
      expect(platform({ cors_allowed_origins: '' })).toEqual([]);
    });
  });

  describe('AS-141 the report names keys, never values', () => {
    it('assertValid lists every violated rule in one error without any value', () => {
      const set = new ConfigRuleSet();
      platformRules.forEach((rule) => set.register(rule));
      let message = '';
      try {
        set.assertValid(
          {
            platform_currency: 'eur',
            db_pool_max: 20,
            db_max_instances: 10,
            db_connection_limit: 150,
            trusted_proxies: 's3cr3t-value',
          },
          { production: false },
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/platform_currency/);
      expect(message).toMatch(/db_pool_max/);
      expect(message).not.toContain('s3cr3t-value');
      expect(message).not.toContain('eur');
    });
  });
});
