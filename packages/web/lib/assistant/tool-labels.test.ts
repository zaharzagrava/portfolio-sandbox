import { describe, expect, it } from 'vitest';
import { toolLabel, toolStatusText } from './tool-labels';

describe('Tool labels', () => {
  it('W05 AS-43 UA3: each known tool has three states with text: running, done and failed', () => {
    const table: [string, string, string, string][] = [
      ['search_products', 'Searching products…', 'Searched products', "Couldn't search products"],
      ['product_details', 'Reading product details…', 'Read product details', "Couldn't read product details"],
      ['pickup_near_me', 'Checking pickup points near you…', 'Checked pickup points', "Couldn't check pickup points"],
    ];
    for (const [name, running, done, failed] of table) {
      expect(toolLabel(name, 'running'), name).toBe(running);
      expect(toolLabel(name, 'done'), name).toBe(done);
      expect(toolLabel(name, 'failed'), name).toBe(failed);
    }
  });

  it('W05 AS-43 UA3: an unknown tool shows its name with the underscores replaced by spaces, in every state', () => {
    for (const status of ['running', 'done', 'failed'] as const) expect(toolLabel('check_gift_card', status)).toBe('check gift card');
    expect(toolLabel('_odd__name_', 'done')).toBe('odd name');
    expect(toolLabel('', 'done')).toBe('tool');
  });

  it('W05 AS-43 AS-66 UA3: the status also has words for a screen reader (never only an icon)', () => {
    expect(toolStatusText('running')).toBe('In progress');
    expect(toolStatusText('done')).toBe('Done');
    expect(toolStatusText('failed')).toBe('Failed');
  });
});
