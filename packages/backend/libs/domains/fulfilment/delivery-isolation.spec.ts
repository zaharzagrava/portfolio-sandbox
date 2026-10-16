import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OWNERSHIP, ownerOf } from '../../../db/ownership';

const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const list = (dir: string) =>
  readdirSync(join(root, dir)).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  );

/** The delivery (S20) files: everything that is not part of the pickup (S19) half. */
const deliveryFiles = (dir: string) =>
  list(dir).filter((f) => !f.startsWith('pickup'));

describe('S20 AS-58: delivery isolation (D-6, D-8)', () => {
  it('S20 AS-58: every table of the capability is owned by domain:fulfilment', () => {
    for (const table of [
      'Courier',
      'Delivery',
      'DeliveryEvent',
      'DeliveryOffer',
      'DeliverableOrder',
    ]) {
      expect(ownerOf(table)).toBe('domain:fulfilment');
      expect(OWNERSHIP).toHaveProperty(table);
    }
  });

  it('S20 AS-58: the barrel exports modules, DTO types and event contracts only', () => {
    const barrel = read('index.ts');
    const names = [
      ...barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g),
    ].flatMap((m) =>
      m[1]
        .split(',')
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)
            .pop()!,
        )
        .filter(Boolean),
    );
    expect(names).toEqual(expect.arrayContaining(['DeliveryModule']));
    for (const name of names) {
      expect(name).not.toMatch(
        /(Repository|Model|Projector$|Job|Worker$|Store|Adapter|Handlers|Heartbeat|Registry)/,
      );
    }
    for (const forbidden of [
      'CourierTrackProjector',
      'SurgeJob',
      'OfferTimeoutWorker',
      'DeliveryQueueWorker',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // no `export *` from infra
    expect(barrel).not.toMatch(/from '\.\/infra\//);
  });

  it('S20 AS-58: api/ and application/ delivery files import nothing from infra/', () => {
    const offenders: string[] = [];
    for (const dir of ['api', 'application']) {
      for (const file of deliveryFiles(dir)) {
        const src = read(join(dir, file));
        if (/from\s+'(\.\.\/infra\/|\.\/infra\/)/.test(src))
          offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('S20 AS-58: domain/ delivery files import no infra, application or api code', () => {
    const offenders: string[] = [];
    for (const file of deliveryFiles('domain')) {
      const src = read(join('domain', file));
      if (/from\s+'\.\.\/(infra|application|api)\//.test(src))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('S20 AS-58: no delivery file opens a transaction directly', () => {
    const offenders: string[] = [];
    for (const dir of ['api', 'application', 'infra', 'domain']) {
      for (const file of deliveryFiles(dir)) {
        const src = read(join(dir, file));
        if (/sequelize\.transaction|S54 T037 audit/.test(src))
          offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
