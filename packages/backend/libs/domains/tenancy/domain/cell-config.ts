import type { RuleContext } from '@app/common/config/config-rules';

export const DEFAULT_CELL_POOL_MAX = 5;
export const DEFAULT_CELL_ACQUIRE_TIMEOUT_MS = 2000;
export const DEFAULT_CELL_CONNECTION_LIMIT = 100;
export const DEFAULT_CELL_RESERVED_CONNECTIONS = 20;
export const POOLED_CELL = 'pooled';

const CELL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `TENANCY_CELLS` = `{"dedicated-1":"postgres://…"}`; `undefined` when it is not that shape. */
export function parseCells(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  const cells: Record<string, string> = {};
  for (const [name, url] of Object.entries(parsed)) {
    if (name === POOLED_CELL || !CELL_NAME.test(name)) return undefined;
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\//.test(url))
      return undefined;
    cells[name] = url;
  }
  return cells;
}

const num = (ctx: RuleContext, key: string): number | undefined => {
  const value = ctx.get(key);
  return typeof value === 'number' ? value : undefined;
};

/**
 * Startup rules of the cells and regions (S03 plan III.12, VIII.5). Messages name keys and the broken rule, never a
 * value (a cell URL carries a password).
 */
export function tenancyConfigProblems(ctx: RuleContext): string[] {
  const found: string[] = [];
  const cells = parseCells(ctx.get('tenancy_cells') as string | undefined);
  if (!cells)
    found.push(
      'tenancy_cells must be a JSON object of cell name (lower-case, not "pooled") to postgres:// URL',
    );

  const regions = ctx.get('tenancy_regions');
  if (typeof regions === 'string' && regions.trim() !== '') {
    const list = regions.split(',').map((r) => r.trim());
    if (list.some((r) => !REGION.test(r)))
      found.push('tenancy_regions must be a comma list of region names');
  }

  const pool = num(ctx, 'tenancy_cell_pool_max') ?? DEFAULT_CELL_POOL_MAX;
  const instances = num(ctx, 'db_max_instances');
  if (cells && Object.keys(cells).length > 0 && instances !== undefined) {
    const limit =
      num(ctx, 'tenancy_cell_connection_limit') ??
      DEFAULT_CELL_CONNECTION_LIMIT;
    const reserved =
      num(ctx, 'tenancy_cell_reserved_connections') ??
      DEFAULT_CELL_RESERVED_CONNECTIONS;
    if (pool * instances >= limit - reserved)
      found.push(
        `tenancy_cell_pool_max × db_max_instances = ${pool} × ${instances} = ${pool * instances} must stay below tenancy_cell_connection_limit − tenancy_cell_reserved_connections (${limit - reserved})`,
      );
  }
  return found;
}
