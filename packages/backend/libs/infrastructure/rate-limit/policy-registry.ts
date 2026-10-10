import { Injectable, Logger } from '@nestjs/common';
import type { PolicyTable } from './policy';
import { validatePolicyTable } from './policy-validation';
import { DEFAULT_POLICIES, type RateLimitPolicy } from './rate-limit.types';

/**
 * The one runtime table of policies (FR-050, FR-051). Each capability registers its own through `forFeature`; the lib
 * itself declares only the two defaults. Registration fails startup on an invalid table (every offence at once) and on
 * a duplicate name (both owners named).
 */
@Injectable()
export class PolicyRegistry {
  private readonly logger = new Logger('RateLimitRegistry');
  private readonly policies = new Map<
    string,
    { policy: RateLimitPolicy; owner: string }
  >();

  constructor() {
    this.register({
      owner: 'infrastructure:rate-limit',
      policies: DEFAULT_POLICIES,
    });
  }

  register(table: PolicyTable): void {
    const offences = validatePolicyTable(table.policies);
    for (const [name, policy] of Object.entries(table.policies)) {
      const existing = this.policies.get(name);
      // The same owner registering the same declaration again (a table imported by two modules) is not a clash.
      if (
        existing &&
        !(
          existing.owner === table.owner &&
          JSON.stringify(existing.policy) === JSON.stringify(policy)
        )
      )
        offences.push(
          `policy "${name}" is declared twice: by "${existing.owner}" and by "${table.owner}"`,
        );
    }
    if (offences.length)
      throw new Error(
        `Rate limit policies of "${table.owner}" are invalid:\n- ${offences.join('\n- ')}`,
      );
    for (const [name, policy] of Object.entries(table.policies))
      this.policies.set(name, { policy, owner: table.owner });
  }

  has(name: string): boolean {
    return this.policies.has(name);
  }

  /** An undeclared name is a programming error (the type system stops it in source; this stops it at runtime). */
  get(name: string): RateLimitPolicy {
    const found = this.policies.get(name);
    if (!found) throw new Error(`Rate limit policy "${name}" is not declared`);
    return found.policy;
  }

  names(): string[] {
    return [...this.policies.keys()];
  }

  /** Startup: every route-level reference must name a declared policy (AS-71). */
  assertDeclared(references: { policy: string; where: string }[]): void {
    const missing = references
      .filter((r) => !this.policies.has(r.policy))
      .map((r) => `${r.where} uses undeclared policy "${r.policy}"`);
    if (missing.length)
      throw new Error(
        `Undeclared rate limit policies:\n- ${missing.join('\n- ')}`,
      );
  }
}
