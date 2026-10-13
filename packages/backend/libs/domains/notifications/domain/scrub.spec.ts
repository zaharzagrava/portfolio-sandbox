import { scrub } from './scrub';

describe('S28 AS-85: scrub removes contact data and tokens from outside text (pure)', () => {
  it.each([
    ['mailbox unavailable: alice@mail.com', 'mailbox unavailable: [address]'],
    ['bad number +380 50 123 45 67 rejected', 'bad number [number] rejected'],
    ['bad number +380501234567', 'bad number [number]'],
    [
      'token fR8x_2kLm9QpZ4vB7nT1yU6wE3aS5dHjC0 is not registered',
      'token [token] is not registered',
    ],
    ['connection reset', 'connection reset'],
  ])('%s', (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it('cuts long text', () => {
    expect(scrub('x '.repeat(500))).toHaveLength(200);
  });
});
