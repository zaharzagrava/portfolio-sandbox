import {
  notificationsProvidersRule,
  notificationsSecretsRule,
} from './notifications-config';

const ctx = (values: Record<string, unknown>, production: boolean) => ({
  get: (key: string) => values[key],
  production,
});

const SECRET = 'n'.repeat(40);
const PROVIDERS = {
  ses_from_address: 'Shop <no-reply@shop.example>',
  twilio_account_sid: 'AC1',
  twilio_auth_token: 'token',
  twilio_from: '+15005550006',
  firebase_client_email: 'svc@project.iam.gserviceaccount.com',
  firebase_private_key: '-----BEGIN PRIVATE KEY-----',
};

describe('Notifications: configuration rules', () => {
  it('S28 AS-54: production without notification_secret is refused, and the unsubscribe key has no JWT fallback', () => {
    expect(notificationsSecretsRule(ctx({ jwt_secret: SECRET }, true))).toEqual(
      ['notification_secret is required'],
    );
    expect(
      notificationsSecretsRule(ctx({ notification_secret: SECRET }, true)),
    ).toEqual([]);
  });

  it('S28 AS-54: the secret must be at least 32 bytes in production and differ from every other secret', () => {
    expect(
      notificationsSecretsRule(ctx({ notification_secret: 'short' }, true)),
    ).toEqual(['notification_secret must be at least 32 bytes']);
    expect(
      notificationsSecretsRule(
        ctx({ notification_secret: SECRET, jwt_secret: SECRET }, false),
      ),
    ).toEqual(['notification_secret must differ from jwt_secret']);
    // outside production a short secret is accepted (test environments)
    expect(
      notificationsSecretsRule(ctx({ notification_secret: 'test' }, false)),
    ).toEqual([]);
  });

  it.each([
    ['ses_from_address', 'an e-mail provider is required'],
    ['twilio_auth_token', 'twilio_auth_token is required (sms channel)'],
    ['firebase_private_key', 'firebase_private_key is required (push channel)'],
  ])(
    'S28 AS-54: production without %s fails startup naming the setting',
    (missing, message) => {
      const values: Record<string, unknown> = { ...PROVIDERS };
      delete values[missing];
      const found = notificationsProvidersRule(ctx(values, true));
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(message);
    },
  );

  it('S28 AS-54: the memory mailbox and missing providers are accepted outside production only', () => {
    expect(
      notificationsProvidersRule(ctx({ email_provider: 'memory' }, false)),
    ).toEqual([]);
    expect(
      notificationsProvidersRule(
        ctx({ ...PROVIDERS, email_provider: 'memory' }, true),
      ),
    ).toEqual(['email_provider=memory is not allowed in production']);
    expect(notificationsProvidersRule(ctx(PROVIDERS, true))).toEqual([]);
  });
});
