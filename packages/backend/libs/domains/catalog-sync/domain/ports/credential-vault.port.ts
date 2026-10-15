export const CREDENTIAL_VAULT = Symbol('CREDENTIAL_VAULT');

/** Credentials are bound to their row: sealed with context `integration:<id>`. */
export interface CredentialVault {
  seal(integrationId: string, plaintext: string): string;
  /** Throws when the value was sealed for another integration (or without a context). */
  open(integrationId: string, sealed: string): string;
}
