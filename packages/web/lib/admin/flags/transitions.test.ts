import { describe, expect, it } from 'vitest';
import { availableActions } from './transitions';

describe('availableActions', () => {
  it('W06 FR-031: the lifecycle actions offered per status', () => {
    expect(availableActions('enabled')).toEqual(['kill']);
    expect(availableActions('disabled')).toEqual(['kill', 'archive']);
    expect(availableActions('killed')).toEqual(['restore', 'archive']);
    expect(availableActions('archived')).toEqual([]);
  });
});
