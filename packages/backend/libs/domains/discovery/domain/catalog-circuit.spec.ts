import { CatalogCircuit } from './catalog-circuit';

describe('catalog circuit', () => {
  let now = 0;
  let circuit: CatalogCircuit;
  beforeEach(() => {
    now = 1_000;
    circuit = new CatalogCircuit({
      failureThreshold: 5,
      openMs: 10_000,
      now: () => now,
    });
  });
  const fail = (n: number) => {
    for (let i = 0; i < n; i++) {
      expect(circuit.tryAcquire()).toBe(true);
      circuit.recordFailure();
    }
  };

  it('S33 AS-21: five consecutive failures open the circuit for ten seconds', () => {
    fail(4);
    expect(circuit.state).toBe('closed');
    fail(1);
    expect(circuit.state).toBe('open');
    expect(circuit.tryAcquire()).toBe(false);
    now += 9_999;
    expect(circuit.tryAcquire()).toBe(false);
  });

  it('S33 AS-21: a success resets the failure count', () => {
    fail(4);
    expect(circuit.tryAcquire()).toBe(true);
    circuit.recordSuccess();
    fail(4);
    expect(circuit.state).toBe('closed');
  });

  it('S33 AS-21: after the open period exactly one probe is allowed; success closes it', () => {
    fail(5);
    now += 10_000;
    expect(circuit.tryAcquire()).toBe(true); // the probe
    expect(circuit.state).toBe('half_open');
    expect(circuit.tryAcquire()).toBe(false); // concurrent calls skip
    circuit.recordSuccess();
    expect(circuit.state).toBe('closed');
    expect(circuit.tryAcquire()).toBe(true);
  });

  it('S33 AS-21: a failed probe reopens the circuit for another ten seconds', () => {
    fail(5);
    now += 10_000;
    expect(circuit.tryAcquire()).toBe(true);
    circuit.recordFailure();
    expect(circuit.state).toBe('open');
    now += 9_999;
    expect(circuit.tryAcquire()).toBe(false);
    now += 1;
    expect(circuit.tryAcquire()).toBe(true);
  });
});
