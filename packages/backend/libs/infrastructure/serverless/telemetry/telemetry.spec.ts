import { log, metric, configureTelemetry } from './telemetry';
import { captureTelemetry, FakeClock, type Capture } from '../testing';

describe('telemetry', () => {
  let capture: Capture;
  const clock = new FakeClock(Date.parse('2026-03-04T05:06:07.000Z'));
  beforeEach(() => (capture = captureTelemetry(clock)));
  afterEach(() => capture.restore());

  it.each([
    ['no dimension', {}, [[]]],
    ['one dimension', { function: 'f' }, [['function']]],
    [
      'three dimensions',
      { function: 'f', queue: 'q', outcome: 'ok' },
      [['function', 'queue', 'outcome']],
    ],
  ])(
    'S55 AS-51: a metric with %s is a valid embedded-metric-format line listing exactly those keys',
    (_n, dimensions, listed) => {
      metric('Marketplace/Lambda', 'RecordsProcessed', 3, 'Count', dimensions);
      const [line] = capture.json();
      expect(line._aws.CloudWatchMetrics[0]).toEqual({
        Namespace: 'Marketplace/Lambda',
        Dimensions: listed,
        Metrics: [{ Name: 'RecordsProcessed', Unit: 'Count' }],
      });
      expect(line._aws.Timestamp).toBe(clock.now());
      expect(line.RecordsProcessed).toBe(3);
      expect(line).toMatchObject(dimensions);
    },
  );

  it.each([
    ['four dimensions', 1, 'Count', { a: '1', b: '2', c: '3', d: '4' }],
    ['a NaN value', Number.NaN, 'Count', {}],
    ['an infinite value', Number.POSITIVE_INFINITY, 'Count', {}],
    ['an unknown unit', 1, 'Parsecs', {}],
  ])(
    'S55 AS-51: %s writes nothing to the metric stream, logs a warning and does not throw',
    (_n, value, unit, dimensions) => {
      expect(() =>
        metric('Marketplace/Lambda', 'Bad', value, unit, dimensions),
      ).not.toThrow();
      expect(capture.metrics()).toHaveLength(0);
      expect(capture.logs('metric dropped')).toEqual([
        expect.objectContaining({ level: 'warn', metric: 'Bad' }),
      ]);
    },
  );

  it('S55 AS-51: log lines use level, message, time (from the injected clock) and traceId', () => {
    log('info', 'hello', { traceId: 'abc', n: 1 });
    expect(capture.json()[0]).toEqual({
      level: 'info',
      message: 'hello',
      time: '2026-03-04T05:06:07.000Z',
      traceId: 'abc',
      n: 1,
    });
  });

  it('S55 AS-51: an output that throws never throws into the handler', () => {
    const restore = configureTelemetry({
      write: () => {
        throw new Error('stream closed');
      },
    });
    try {
      expect(() => log('error', 'x')).not.toThrow();
      expect(() => metric('N', 'M', 1, 'Count')).not.toThrow();
    } finally {
      restore();
    }
  });
});
