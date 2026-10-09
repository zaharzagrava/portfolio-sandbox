import { registeredEventDefinitions } from '@app/infrastructure/events/define-event';
import { ConsumerDeclarationError } from './errors';
import type { Projector } from './projector';

const MECHANISMS = ['inbox', 'versionGuard', 'natural'];

/**
 * Pure startup check of one consumer (S53 FR-025, FR-033): a declared idempotency mechanism, a name, topics, a sane
 * attempt budget, and no `coalesce` where an event on the topic does not carry the full state. Throws one
 * `ConsumerDeclarationError` naming the consumer with every problem found.
 */
export function validateDeclaration(projector: Projector): void {
  const problems: string[] = [];
  if (!projector.name) problems.push('name is required');
  if (!MECHANISMS.includes(projector.idempotency))
    problems.push(
      `idempotency must be one of ${MECHANISMS.join(', ')} (got ${JSON.stringify(projector.idempotency ?? null)})`,
    );
  if (!projector.topics || projector.topics.length === 0)
    problems.push('topics must list at least one topic');
  if (
    projector.attempts !== undefined &&
    (!Number.isInteger(projector.attempts) || projector.attempts < 1)
  )
    problems.push('attempts must be a positive integer');

  if (projector.coalesce) {
    const delta = new Set<string>();
    for (const handled of projector.handles ?? [])
      if (handled.event.carries !== 'state') delta.add(handled.event.type);
    const aggregates = new Set(
      (projector.topics ?? []).map((t) => t.replace(/\.events$/, '')),
    );
    for (const definition of registeredEventDefinitions().values())
      if (
        aggregates.has(definition.aggregateType) &&
        definition.carries !== 'state'
      )
        delta.add(definition.type);
    if (delta.size > 0)
      problems.push(
        `coalesce is only valid for events that carry the full aggregate state; not marked carries: 'state': ${[...delta].join(', ')}`,
      );
  }

  if (problems.length > 0)
    throw new ConsumerDeclarationError(projector.name || '(unnamed)', problems);
}

/** The consumers registered in this process: group names are unique (one group, one set of offsets). */
export class ConsumerDeclarations {
  private readonly names = new Set<string>();

  register(projector: Projector): void {
    validateDeclaration(projector);
    if (this.names.has(projector.name))
      throw new ConsumerDeclarationError(projector.name, [
        `another consumer already uses the group name "${projector.name}"`,
      ]);
    this.names.add(projector.name);
  }

  has(name: string): boolean {
    return this.names.has(name);
  }
}
