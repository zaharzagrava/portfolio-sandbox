/** Test double for the identity `BREACH_CHECKER` port (S01 T002): a configurable breached set, or a failure mode. */
export class FakeBreachChecker {
  readonly breached = new Set<string>();
  /** `throw` = the corpus is unreachable; `timeout` = it never answers within the adapter budget. */
  mode: 'ok' | 'throw' | 'timeout' = 'ok';
  readonly calls: string[] = [];

  async isBreached(password: string): Promise<boolean> {
    this.calls.push(password);
    if (this.mode === 'throw') throw new Error('breach corpus unavailable');
    if (this.mode === 'timeout') throw new Error('breach corpus timed out');
    return this.breached.has(password);
  }

  reset(): void {
    this.breached.clear();
    this.calls.length = 0;
    this.mode = 'ok';
  }
}
