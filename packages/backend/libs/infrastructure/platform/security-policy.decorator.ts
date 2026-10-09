import { SetMetadata } from '@nestjs/common';

/** Metadata key in its own file so the decorator and the bootstrap that reads it never import each other. */
export const SECURITY_POLICY = Symbol('security-policy');

/**
 * Named relaxations of the strict default response policy (FR-070). `public-embed`: a route group meant to be loaded
 * from any site (widgets, public assets) - `Access-Control-Allow-Origin: *` without credentials and
 * `Cross-Origin-Resource-Policy: cross-origin`. The owner of the route declares it; every other route stays strict.
 */
export type SecurityPolicyName = 'public-embed';

export const SecurityPolicy = (name: SecurityPolicyName) =>
  SetMetadata(SECURITY_POLICY, name);
