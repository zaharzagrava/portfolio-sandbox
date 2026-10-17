import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as entryPoint from './index';

/** Crawler files belong to S41 (same domain, another capability). */
const S41 =
  /crawler|frontier|robots|simhash|extract-price|\/url\.ts|seller-insights-events/;

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) &&
      !/\.(e2e-)?spec\.ts$/.test(name) &&
      !path.includes('/testing/') &&
      !S41.test(path)
      ? [path]
      : [];
  });

describe('Seller insights: data ownership of the entry point', () => {
  it('S40 AS-62: the domain entry point exports modules only, no model and no consumer class', () => {
    // S41 replaced `CrawlerModule` by the core, worker and projector modules of the competitor monitor
    expect(Object.keys(entryPoint).sort()).toEqual([
      'CompetitorProjectorModule',
      'CompetitorsModule',
      'CrawlerWorkerModule',
      'LeaderboardsModule',
      'LeaderboardsWorkerModule',
      'SellerInsightsProjectorModule',
      'SellerStatsModule',
    ]);
    expect(
      Object.keys(entryPoint).every((name) => name.endsWith('Module')),
    ).toBe(true);
  });

  it('S40 AS-62: no source of the capability reads another domain’s model or table, or opens a transaction by hand', () => {
    const files = sources(__dirname);
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect([
        file,
        /\b(ProductModel|ShopModel|ShopMembershipModel|MembershipService)\b/.test(
          text,
        ),
      ]).toEqual([file, false]);
      expect([
        file,
        /(FROM|JOIN)\s+"(Shop|Product|ShopMembership|BisOrder)"/i.test(text),
      ]).toEqual([file, false]);
      expect([file, /sequelize\.transaction\(/.test(text)]).toEqual([
        file,
        false,
      ]);
      expect([
        file,
        /from '@app\/domains\/(catalog|tenancy|orders)\/(?!index)/.test(text),
      ]).toEqual([file, false]);
    }
  });
});
