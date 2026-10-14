import { SetMetadata } from '@nestjs/common';

/** Metadata key in its own file so the decorator and the bootstrap that reads it never import each other. */
export const SECURITY_POLICY = Symbol('security-policy');

/**
 * Named relaxations of the strict default response policy (FR-070). `public-embed`: a route group meant to be loaded
 * from any site (widgets, public assets) - `Access-Control-Allow-Origin: *` without credentials and
 * `Cross-Origin-Resource-Policy: cross-origin`. The owner of the route declares it; every other route stays strict.
 *
 * `widget-site` (S44 FR-013): a route group whose cross-origin access is decided per site by its owner. The application
 * wide CORS policy does not apply (no header, no preflight answer); `OPTIONS` reaches the route's own handler. Responses
 * use the cross-origin resource policy like `public-embed`.
 */
export type SecurityPolicyName = 'public-embed' | 'widget-site';

export const SecurityPolicy = (name: SecurityPolicyName) =>
  SetMetadata(SECURITY_POLICY, name);
