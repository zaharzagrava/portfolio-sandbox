import { API_URL, sellerCall, sellerSession } from './helpers';

/**
 * W02 B-6 (test-plan "Data setup", gaps G8, H5, H6): what the journeys need from the dev stack besides `seed:dev`.
 *
 * Two kinds of seed:
 *  - `built`: the journey builds it itself through the owner's real seller API (pickup point with stock, public knowledge
 *    document). The stack must offer that API, or the journey would time out; `checkSeeds` fails fast and names the seed.
 *  - `noHook`: no owner hook exists in the dev stack (S33 dataset S, S34 dataset D, S35 dataset T, S47 scripted cited turn, S30
 *    READY video). The journeys that need them stay `test.fixme` (questions.md Q-W02-1, -2, -3, -6, -7, -8); they are named in a
 *    notice so a run says what it is not proving, and they never fail the run.
 */
export interface SeedProbe {
  /** What is missing, named for the failure message. */
  name: string;
  /** Owner capability that provides it. */
  owner: string;
  /** Journey files that depend on it. */
  journeys: string[];
}

export const BUILT_SEEDS: SeedProbe[] = [
  { name: 'pickup point with stock (seller pickup-points API)', owner: 'S19', journeys: ['tests/storefront-discovery.spec.ts', 'tests/visual/product-panels.spec.ts'] },
  { name: 'public knowledge document (seller knowledge API)', owner: 'S47', journeys: ['tests/product-community.spec.ts', 'tests/knowledge.spec.ts'] },
];

export const NO_HOOK_SEEDS: SeedProbe[] = [
  { name: 'suggestion dataset S ("iph")', owner: 'S33', journeys: ['tests/search.spec.ts'] },
  { name: 'bought-together dataset D', owner: 'S34', journeys: ['tests/product-recommendations.spec.ts', 'tests/storefront-discovery.spec.ts'] },
  { name: 'trending dataset T on demand', owner: 'S35', journeys: ['tests/home-trending.spec.ts'] },
  { name: 'scripted model provider that cites the document', owner: 'S47', journeys: ['tests/product-community.spec.ts'] },
  { name: 'READY public product video', owner: 'S30', journeys: ['tests/product-video.spec.ts'] },
];

/** The built seeds the stack cannot offer, named. Pure over `status` (route to HTTP status), so it is testable. */
export async function missingBuiltSeeds(status: (route: string) => Promise<number>, shopId: string): Promise<string[]> {
  const routes: [SeedProbe, string][] = [
    [BUILT_SEEDS[0]!, `/api/shops/${shopId}/pickup-points`],
    [BUILT_SEEDS[1]!, `/api/shops/${shopId}/knowledge/documents`],
  ];
  const missing: string[] = [];
  for (const [seed, route] of routes) {
    const code = await status(route);
    if (code === 404 || code === 501 || code === 0) missing.push(`${seed.name} [${seed.owner}; needed by ${seed.journeys.join(', ')}]`);
  }
  return missing;
}

/** Run by global setup after `seed:dev`: throws naming each missing built seed, and prints the no-hook seeds as a notice. */
export async function checkSeeds(): Promise<void> {
  let session: { token: string; shopId: string };
  try {
    session = await sellerSession();
  } catch {
    // seed:dev failed (already warned): the seller is missing, so the journeys that need seeds cannot run anyway.
    return;
  }
  const missing = await missingBuiltSeeds(async (route) => {
    try {
      return (await sellerCall('GET', route, undefined, session.token)).status;
    } catch {
      return 0;
    }
  }, session.shopId);
  if (missing.length > 0) {
    throw new Error(`Missing journey seed(s) on ${API_URL}:\n - ${missing.join('\n - ')}\nStart the stack with the owning capability built (moon run :dev-monolith).`);
  }
  console.log(
    `NOTICE: no dev-stack hook for ${NO_HOOK_SEEDS.map((seed) => `${seed.name} [${seed.owner}]`).join('; ')}; their journeys stay fixme (questions.md).`,
  );
}
