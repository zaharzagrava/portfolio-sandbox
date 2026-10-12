export const DEFAULT_REGIONS = ['eu-central-1', 'us-east-1'];

/** `TENANCY_REGIONS` (comma list, the first is the default) or the built-in pair when unset. */
export function allowedRegions(configured: string | undefined): string[] {
  const list = (configured ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_REGIONS;
}
