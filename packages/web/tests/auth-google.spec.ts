import { test } from '@playwright/test';

/**
 * JG (W01 AS-58..AS-61): Google sign-in and linking. Fixme until contract C-OIDC is in force (S48 + S02: the callback must
 * create the BFF session and the federated second step must end at `POST /api/bff/session/mfa`; see gaps.md D4). The UI is
 * built and unit-tested behind `AUTH_OIDC_ENABLED` (login-form.test.tsx, sign-in-methods-panel.test.tsx).
 */
test.describe('Google sign-in @desktop', () => {
  test.fixme('continue with Google', async () => {
    // AS-58, AS-59: Continue with Google starts, the provider approves, the callback lands signed in on the page we came from.
  });

  test.fixme('google with two-step', async () => {
    // AS-60: a member with two-step verification arrives at /login/mfa?returnTo=… after the callback and finishes as AS-32.
  });

  test.fixme('link and unlink Google', async () => {
    // AS-61: Sign-in methods tab: Link Google (with a code when two-step is on), ?linked=google banner, Unlink.
  });
});
