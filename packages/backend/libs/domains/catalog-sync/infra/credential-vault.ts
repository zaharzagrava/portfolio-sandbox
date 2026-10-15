import { Injectable } from '@nestjs/common';
import { SecretBox } from '@app/domains/identity';
import type { CredentialVault } from '../domain/ports';

const contextOf = (integrationId: string) => `integration:${integrationId}`;

/** `SecretBox` with the row bound in as AAD: a sealed value copied to another integration fails the tag check. */
@Injectable()
export class SecretBoxCredentialVault implements CredentialVault {
  constructor(private readonly box: SecretBox) {}

  seal(integrationId: string, plaintext: string): string {
    return this.box.seal(plaintext, contextOf(integrationId));
  }

  open(integrationId: string, sealed: string): string {
    return this.box.open(sealed, contextOf(integrationId));
  }
}
