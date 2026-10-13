import {
  ProviderUnavailableError,
  type ProviderStatement,
  type StatementPage,
} from '../domain/ledger-ports';

export type StatementFault = 'timeout' | 'rate_limited' | 'unavailable';

export interface StatementCall {
  op: 'list' | 'find';
  /** 1-based page number for `list`, the reference for `find`. */
  page?: number;
  reference?: string;
  /** Pages handed out but not yet followed by the next request: the run holds at most this many. */
  outstanding?: number;
  at: number;
}

/**
 * A scriptable statement double behind `PROVIDER_STATEMENT` (S14 test-plan.md): the lines of a day, a page size, faults
 * on a page, lookups by reference, and a call log. The adapter's retry count is its call count per page: 1.
 */
export class FakeProviderStatement implements ProviderStatement {
  lines: unknown[] = [];
  /** References the provider knows outside the listed day (boundary lookups). */
  known = new Set<string>();
  /** Fail the nth list call (1-based) once or always. */
  faults = new Map<number, { fault: StatementFault; times: number }>();
  readonly calls: StatementCall[] = [];
  /** Between delivering a page and receiving the request for the next one. */
  maxOutstanding = 0;
  private outstanding = 0;
  private listCalls = 0;
  /** Awaited before a page is returned: lets a spec stop the world between pages. */
  beforePage?: (page: number) => Promise<void> | void;

  reset(): void {
    this.lines = [];
    this.known.clear();
    this.faults.clear();
    this.calls.length = 0;
    this.maxOutstanding = 0;
    this.outstanding = 0;
    this.listCalls = 0;
    this.beforePage = undefined;
  }

  failOn(call: number, fault: StatementFault, times = 1): void {
    this.faults.set(call, { fault, times });
  }

  async listLines(input: {
    fromInclusive: Date;
    toExclusive: Date;
    cursor: string | null;
    limit: number;
  }): Promise<StatementPage> {
    this.outstanding = 0; // a request for the next page means the previous one was processed
    this.listCalls++;
    const page = this.listCalls;
    this.calls.push({ op: 'list', page, at: Date.now() });
    const planned = this.faults.get(page);
    if (planned && planned.times > 0) {
      planned.times--;
      throw new ProviderUnavailableError(`scripted ${planned.fault}`);
    }
    await this.beforePage?.(page);
    const start = input.cursor ? Number(input.cursor) : 0;
    const slice = this.lines.slice(start, start + input.limit);
    const next = start + input.limit;
    this.outstanding++;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    this.calls[this.calls.length - 1].outstanding = this.outstanding;
    return {
      lines: slice,
      nextCursor: next < this.lines.length ? String(next) : null,
    };
  }

  findByReference(reference: string): Promise<unknown> {
    this.calls.push({ op: 'find', reference, at: Date.now() });
    if (this.known.has(reference))
      return Promise.resolve({ id: `txn_${reference}`, reference });
    const listed = this.lines.find(
      (l) => (l as { reference?: string })?.reference === reference,
    );
    return Promise.resolve(listed ?? null);
  }
}

/** A well-formed provider line for a charge, refund or dispute. */
export function statementLine(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `txn_${Math.random().toString(36).slice(2, 10)}`,
    type: 'charge',
    reference: `pi_${Math.random().toString(36).slice(2, 10)}`,
    amount: 100,
    currency: 'eur',
    created: Math.floor(Date.now() / 1000),
    ...over,
  };
}
