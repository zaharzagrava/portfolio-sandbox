import {
  CAMPAIGN_ACTIONS,
  CAMPAIGN_STATUSES,
  isSponsored,
  nextStatus,
  type CampaignAction,
  type CampaignStatus,
} from './campaign-state';

const LEGAL: Record<string, CampaignStatus> = {
  'ACTIVE pause': 'PAUSED',
  'PAUSED resume': 'ACTIVE',
  'ACTIVE end': 'ENDED',
  'PAUSED end': 'ENDED',
};

describe('S36 AS-15: campaign state machine', () => {
  const pairs = CAMPAIGN_STATUSES.flatMap((from) =>
    CAMPAIGN_ACTIONS.map((action) => [from, action] as const),
  );

  it('covers all 3 x 3 pairs', () => expect(pairs).toHaveLength(9));

  it.each(pairs)('%s + %s', (from: CampaignStatus, action: CampaignAction) => {
    expect(nextStatus(from, action)).toBe(LEGAL[`${from} ${action}`] ?? null);
  });

  it('ENDED has no outgoing transition', () => {
    for (const action of CAMPAIGN_ACTIONS)
      expect(nextStatus('ENDED', action)).toBeNull();
  });

  it('the sponsored value is true only for ACTIVE', () => {
    expect(CAMPAIGN_STATUSES.filter(isSponsored)).toEqual(['ACTIVE']);
  });
});
