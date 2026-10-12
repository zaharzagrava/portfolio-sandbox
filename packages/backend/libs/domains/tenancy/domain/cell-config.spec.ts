import type { RuleContext } from '@app/common/config/config-rules';
import { parseCells, tenancyConfigProblems } from './cell-config';

const ctx = (values: Record<string, unknown>): RuleContext => ({
  get: (key) => values[key],
  production: false,
});

describe('S03 cell configuration (FR-051, plan III.12)', () => {
  it('parses a cell map and refuses anything else', () => {
    expect(parseCells(undefined)).toEqual({});
    expect(parseCells('{"dedicated-1":"postgres://u:p@h:5432/db"}')).toEqual({
      'dedicated-1': 'postgres://u:p@h:5432/db',
    });
    for (const bad of [
      'not json',
      '[]',
      '{"pooled":"postgres://h/db"}',
      '{"Bad Name":"postgres://h/db"}',
      '{"cell":"mysql://h/db"}',
      '{"cell":5}',
    ])
      expect(parseCells(bad)).toBeUndefined();
  });

  it('reports a bad cell map without printing the value', () => {
    const found = tenancyConfigProblems(
      ctx({ tenancy_cells: '{"cell":"http://user:secret@h/db"}' }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('tenancy_cells');
    expect(found[0]).not.toContain('secret');
  });

  it('rejects a region list with an empty or malformed entry', () => {
    expect(
      tenancyConfigProblems(ctx({ tenancy_regions: 'eu-central-1,us-east-1' })),
    ).toEqual([]);
    expect(
      tenancyConfigProblems(ctx({ tenancy_regions: 'eu-central-1,' })),
    ).toHaveLength(1);
    expect(
      tenancyConfigProblems(ctx({ tenancy_regions: 'EU Central' })),
    ).toHaveLength(1);
  });

  it('keeps pool × instances below the cell limit minus the reserved connections', () => {
    const cells = '{"dedicated-1":"postgres://h/db"}';
    // default 5 × 10 = 50 < 100 − 20
    expect(
      tenancyConfigProblems(
        ctx({ tenancy_cells: cells, db_max_instances: 10 }),
      ),
    ).toEqual([]);
    // 5 × 16 = 80 is not below 80
    expect(
      tenancyConfigProblems(
        ctx({ tenancy_cells: cells, db_max_instances: 16 }),
      )[0],
    ).toContain('5 × 16 = 80');
    // a cell with another limit
    expect(
      tenancyConfigProblems(
        ctx({
          tenancy_cells: cells,
          db_max_instances: 16,
          tenancy_cell_connection_limit: 200,
        }),
      ),
    ).toEqual([]);
    // no cells configured: nothing to check
    expect(tenancyConfigProblems(ctx({ db_max_instances: 1000 }))).toEqual([]);
  });
});
