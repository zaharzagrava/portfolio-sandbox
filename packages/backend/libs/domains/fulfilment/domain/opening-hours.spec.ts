import { validateOpeningHours } from './opening-hours';

const week = (monday: unknown) => ({
  timezone: 'Europe/Berlin',
  weekly: { mon: monday },
});

describe('S19 AS-11 opening hours', () => {
  it.each([
    ['unknown hours', {}],
    ['one interval', week([{ open: '09:00', close: '18:00' }])],
    [
      'three intervals',
      week([
        { open: '08:00', close: '10:00' },
        { open: '11:00', close: '13:00' },
        { open: '14:00', close: '16:00' },
      ]),
    ],
    [
      'back to back',
      week([
        { open: '08:00', close: '10:00' },
        { open: '10:00', close: '12:00' },
      ]),
    ],
    ['an empty day', week([])],
  ])('accepts %s', (_name, input) => {
    expect(validateOpeningHours(input)).toEqual({ ok: true, value: input });
  });

  it('sorts the intervals of a day by opening time', () => {
    const result = validateOpeningHours(
      week([
        { open: '14:00', close: '16:00' },
        { open: '08:00', close: '10:00' },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      value: week([
        { open: '08:00', close: '10:00' },
        { open: '14:00', close: '16:00' },
      ]),
    });
  });

  it.each([
    ['unknown timezone', { timezone: 'Mars/Base', weekly: {} }],
    ['a timezone that is not text', { timezone: 7, weekly: {} }],
    ['unknown day', { timezone: 'Europe/Berlin', weekly: { funday: [] } }],
    ['time without leading zero', week([{ open: '9:00', close: '18:00' }])],
    ['time past 23:59', week([{ open: '09:00', close: '24:00' }])],
    ['close equal to open', week([{ open: '09:00', close: '09:00' }])],
    ['close before open', week([{ open: '18:00', close: '09:00' }])],
    [
      'overlapping intervals',
      week([
        { open: '08:00', close: '12:00' },
        { open: '11:00', close: '14:00' },
      ]),
    ],
    [
      'four intervals',
      week([
        { open: '01:00', close: '02:00' },
        { open: '03:00', close: '04:00' },
        { open: '05:00', close: '06:00' },
        { open: '07:00', close: '08:00' },
      ]),
    ],
    ['weekly missing', { timezone: 'Europe/Berlin' }],
    ['an array', []],
    ['text', 'always'],
    ['null', null],
    ['an unknown key', { timezone: 'Europe/Berlin', weekly: {}, extra: 1 }],
  ])('refuses %s', (_name, input) => {
    expect(validateOpeningHours(input)).toEqual({
      ok: false,
      field: 'openingHours',
    });
  });
});
