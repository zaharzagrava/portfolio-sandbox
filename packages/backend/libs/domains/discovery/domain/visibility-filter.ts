/**
 * The one visibility filter every query, aggregation, kNN filter and title suggestion carries (R-03, FR-004):
 * `hasProduct:true AND deleted:false AND status:ACTIVE AND shopHidden:false`. Returned as engine `filter` clauses;
 * a fresh array each call so callers may append their own clauses.
 */
export interface TermClause {
  term: Record<string, boolean | string>;
}

export function visibilityFilter(): TermClause[] {
  return [
    { term: { hasProduct: true } },
    { term: { deleted: false } },
    { term: { status: 'ACTIVE' } },
    { term: { shopHidden: false } },
  ];
}
