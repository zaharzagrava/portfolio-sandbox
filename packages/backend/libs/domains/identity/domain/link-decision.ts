export type LinkTrust = 'verified-email' | 'subject-only';

/** What the store says about the account that owns the provider's e-mail address. */
export type EmailMatch =
  /** no user has this address */
  | 'none'
  /** a user without any federated identity (registered with a password nobody proved the address for) */
  | 'plain'
  /** a user that already has a verified-email federated identity */
  | 'federated'
  /** the address belongs to a soft-deleted user */
  | 'deleted';

export interface LinkInput {
  /** A link for (provider, subject) exists. */
  linkExists: boolean;
  /** The owner of that link is soft-deleted. */
  linkedUserDeleted: boolean;
  trust: LinkTrust;
  emailVerified: boolean;
  emailMatch: EmailMatch;
  /** The e-mail-matched user already holds this provider with another subject. */
  sameProviderOtherSubject: boolean;
}

export type RefuseReason =
  'email_not_verified' | 'link_conflict' | 'account_unavailable';

export type LinkDecision =
  | { action: 'login_existing' }
  | { action: 'create_account' }
  | { action: 'link_email_wipe' }
  | { action: 'link_email_plain' }
  | { action: 'refuse'; reason: RefuseReason };

const refuse = (reason: RefuseReason): LinkDecision => ({
  action: 'refuse',
  reason,
});

/**
 * Who a provider login is (FR-060–FR-066). The subject is the stable key; an e-mail address links a login to an
 * existing account only when the provider verified it and the provider is trusted for that, and a link to a
 * password account nobody proved ownership of wipes the password, the factor and the sessions (the caller does it).
 */
export function decideLink(input: LinkInput): LinkDecision {
  if (input.linkExists)
    return input.linkedUserDeleted
      ? refuse('account_unavailable')
      : { action: 'login_existing' };

  // A tenant's identity provider controls its own claims: its login never joins an account by address.
  if (input.trust === 'subject-only') return { action: 'create_account' };

  if (!input.emailVerified) return refuse('email_not_verified');

  switch (input.emailMatch) {
    case 'none':
      return { action: 'create_account' };
    case 'deleted':
      return refuse('account_unavailable');
    case 'plain':
    case 'federated':
      if (input.sameProviderOtherSubject) return refuse('link_conflict');
      return input.emailMatch === 'plain'
        ? { action: 'link_email_wipe' }
        : { action: 'link_email_plain' };
    default:
      return assertNever(input.emailMatch);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable link decision input: ${String(value)}`);
}
