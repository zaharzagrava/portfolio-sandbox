import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ConsumerDeclarationError } from './errors';
import {
  ConsumerDeclarations,
  validateDeclaration,
} from './consumer-declaration';
import { Projector } from './projector';

const schema = z.object({ a: z.string() });
const State = defineEvent('decl.state_changed', 'decl', 1, schema, {
  carries: 'state',
});
const Delta = defineEvent('decl.counter_bumped', 'decl', 1, schema, {
  carries: 'delta',
});
// `decl_state` holds only state events; `decl` (above) mixes both
const OnlyState = defineEvent(
  'declstate.state_changed',
  'declstate',
  1,
  schema,
  { carries: 'state' },
);

const base = (over: Partial<Projector> = {}): Projector => ({
  name: 'decl-consumer',
  topics: ['decl.events'],
  idempotency: 'natural',
  handles: [{ event: State }],
  project: async (_events: EventEnvelope[]) => undefined,
  ...over,
});

describe('S53 consumer declaration', () => {
  it('S53 AS-43: a complete declaration is accepted', () => {
    expect(() => validateDeclaration(base())).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'exactly-once'],
    ['empty', ''],
    ['wrong case', 'Inbox'],
  ])(
    'S53 AS-43: an idempotency mechanism that is %s fails startup naming the consumer',
    (_label, idempotency) => {
      const projector = base({ idempotency: idempotency as never });
      expect(() => validateDeclaration(projector)).toThrow(
        ConsumerDeclarationError,
      );
      expect(() => validateDeclaration(projector)).toThrow(/decl-consumer/);
      expect(() => validateDeclaration(projector)).toThrow(/idempotency/);
    },
  );

  it.each(['inbox', 'versionGuard', 'natural'] as const)(
    'S53 AS-43: idempotency %s is accepted',
    (idempotency) => {
      expect(() => validateDeclaration(base({ idempotency }))).not.toThrow();
    },
  );

  it.each([
    ['empty name', { name: '' }, /name/],
    ['no topics', { topics: [] }, /topics/],
    ['attempts 0', { attempts: 0 }, /attempts/],
    ['attempts 1.5', { attempts: 1.5 }, /attempts/],
    ['attempts negative', { attempts: -3 }, /attempts/],
  ])('S53 AS-43: %s is rejected', (_label, over, message) => {
    expect(() => validateDeclaration(base(over as Partial<Projector>))).toThrow(
      message,
    );
  });

  it('S53 AS-43: every problem is reported together', () => {
    try {
      validateDeclaration(
        base({ idempotency: undefined as never, attempts: 0, topics: [] }),
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConsumerDeclarationError);
      expect((e as ConsumerDeclarationError).problems).toHaveLength(3);
    }
  });

  it('S53 AS-43: two consumers sharing a group name fail at registration, naming it', () => {
    const declarations = new ConsumerDeclarations();
    declarations.register(base());
    expect(() => declarations.register(base())).toThrow(
      ConsumerDeclarationError,
    );
    expect(() => declarations.register(base())).toThrow(/decl-consumer/);
    expect(() =>
      declarations.register(base({ name: 'another' })),
    ).not.toThrow();
  });

  it('S53 AS-41: coalesce on a handled delta event fails startup naming the event type', () => {
    const projector = base({ coalesce: true, handles: [{ event: Delta }] });
    expect(() => validateDeclaration(projector)).toThrow(
      ConsumerDeclarationError,
    );
    expect(() => validateDeclaration(projector)).toThrow(
      /decl\.counter_bumped/,
    );
  });

  it('S53 AS-41: coalesce on a topic whose aggregate has a delta event fails even if the consumer only handles a state event', () => {
    const projector = base({
      coalesce: true,
      topics: ['decl.events'],
      handles: [{ event: State }],
    });
    expect(() => validateDeclaration(projector)).toThrow(
      /decl\.counter_bumped/,
    );
  });

  it('S53 AS-41: coalesce on state events only is accepted', () => {
    const projector = base({
      coalesce: true,
      topics: ['declstate.events'],
      handles: [{ event: OnlyState }],
    });
    expect(() => validateDeclaration(projector)).not.toThrow();
  });

  it('S53 AS-41: a delta event never stops a consumer that does not coalesce', () => {
    expect(() =>
      validateDeclaration(
        base({
          coalesce: false,
          handles: [{ event: Delta }, { event: State }],
        }),
      ),
    ).not.toThrow();
  });
});
