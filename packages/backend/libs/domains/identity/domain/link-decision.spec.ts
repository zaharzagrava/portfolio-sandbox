import { decideLink, type LinkInput } from './link-decision';

const grid = (): LinkInput[] => {
  const out: LinkInput[] = [];
  for (const linkExists of [false, true])
    for (const linkedUserDeleted of [false, true])
      for (const trust of ['verified-email', 'subject-only'] as const)
        for (const emailVerified of [false, true])
          for (const emailMatch of [
            'none',
            'plain',
            'federated',
            'deleted',
          ] as const)
            for (const sameProviderOtherSubject of [false, true])
              out.push({
                linkExists,
                linkedUserDeleted,
                trust,
                emailVerified,
                emailMatch,
                sameProviderOtherSubject,
              });
  return out;
};

const input = (over: Partial<LinkInput>): LinkInput => ({
  linkExists: false,
  linkedUserDeleted: false,
  trust: 'verified-email',
  emailVerified: true,
  emailMatch: 'none',
  sameProviderOtherSubject: false,
  ...over,
});

describe('S02 AS-48: linking decision', () => {
  it.each([
    ['existing link', { linkExists: true }, { action: 'login_existing' }],
    [
      'existing link, owner soft-deleted',
      { linkExists: true, linkedUserDeleted: true },
      { action: 'refuse', reason: 'account_unavailable' },
    ],
    [
      'existing link ignores an unverified e-mail',
      { linkExists: true, emailVerified: false },
      { action: 'login_existing' },
    ],
    ['new verified e-mail, no match', {}, { action: 'create_account' }],
    [
      'verified e-mail matches a password account',
      { emailMatch: 'plain' },
      { action: 'link_email_wipe' },
    ],
    [
      'verified e-mail matches an account with a federated identity',
      { emailMatch: 'federated' },
      { action: 'link_email_plain' },
    ],
    [
      'verified e-mail matches a soft-deleted account',
      { emailMatch: 'deleted' },
      { action: 'refuse', reason: 'account_unavailable' },
    ],
    [
      'unverified e-mail',
      { emailVerified: false },
      { action: 'refuse', reason: 'email_not_verified' },
    ],
    [
      'unverified e-mail that would match',
      { emailVerified: false, emailMatch: 'plain' },
      { action: 'refuse', reason: 'email_not_verified' },
    ],
    [
      'same provider, other subject, matching account',
      { emailMatch: 'federated', sameProviderOtherSubject: true },
      { action: 'refuse', reason: 'link_conflict' },
    ],
    [
      'subject-only provider never links by e-mail',
      { trust: 'subject-only', emailMatch: 'plain' },
      { action: 'create_account' },
    ],
    [
      'subject-only provider with an unverified claim still creates the account',
      { trust: 'subject-only', emailVerified: false },
      { action: 'create_account' },
    ],
  ] as const)('%s', (_name, over, expected) => {
    expect(decideLink(input(over))).toEqual(expected);
  });

  describe('over the full grid', () => {
    const cases = grid();

    it('answers every combination with one member of the closed set', () => {
      expect(cases).toHaveLength(2 * 2 * 2 * 2 * 4 * 2);
      for (const c of cases)
        expect([
          'login_existing',
          'create_account',
          'link_email_wipe',
          'link_email_plain',
          'refuse',
        ]).toContain(decideLink(c).action);
    });

    it('never links by e-mail for a subject-only provider', () => {
      for (const c of cases.filter((x) => x.trust === 'subject-only'))
        expect(['link_email_wipe', 'link_email_plain']).not.toContain(
          decideLink(c).action,
        );
    });

    it('never links by e-mail unless the provider verified the address', () => {
      for (const c of cases.filter((x) => !x.emailVerified && !x.linkExists))
        expect(['link_email_wipe', 'link_email_plain']).not.toContain(
          decideLink(c).action,
        );
    });

    it('wipes only a plain (never-verified) account', () => {
      for (const c of cases)
        if (decideLink(c).action === 'link_email_wipe')
          expect(c.emailMatch).toBe('plain');
    });

    it('never signs a soft-deleted owner in', () => {
      for (const c of cases)
        if (c.linkExists && c.linkedUserDeleted)
          expect(decideLink(c)).toEqual({
            action: 'refuse',
            reason: 'account_unavailable',
          });
    });
  });
});
