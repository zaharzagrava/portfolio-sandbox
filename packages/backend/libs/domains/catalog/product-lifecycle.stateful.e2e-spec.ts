import fc from 'fast-check';
import { productEvents } from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  impossibleProductRows,
  NOTHING_IMPOSSIBLE,
} from './testing/catalog-invariants';

/**
 * QA track 9 (stateful): random sequences of seller actions on ONE product against the real API and database, checked
 * after every action against a small model of what must be true (fast-check commands; a failure is shrunk to the shortest
 * sequence). Actions: edit a field with the right or a stale expectedVersion, set the stock, archive, restore (also in
 * the wrong state). Rules checked after every action:
 *   R1 the version rises by exactly 1 per accepted change, and does not move for a refused or an unchanged edit
 *   R2 stock is what the model says and never below 0
 *   R3 an archived product is never shown to buyers (public read is 404), an active one is (200)
 *   R4 one outbox event per accepted change (events = version) and no impossible row anywhere
 *   R5 a refused action changes nothing
 */
interface Model {
  version: number;
  status: 'ACTIVE' | 'ARCHIVED';
  title: string;
  quantity: number;
  priceMinor: number;
}
interface Real {
  t: CatalogTestApp;
  w: ShopWorld;
  id: string;
}

const path = (r: Real) => `/api/shops/${r.w.shop.id}/products/${r.id}`;

/** After every command: compare the member view, the public view and the outbox with the model. */
async function checkRules(m: Model, r: Real): Promise<void> {
  const seen = (await r.t.as(r.w.staff).get(path(r)).expect(200)).body;
  expect(seen.version).toBe(m.version); // R1
  expect(seen.quantity).toBe(m.quantity); // R2
  expect(seen.quantity).toBeGreaterThanOrEqual(0);
  expect(seen.status).toBe(m.status);
  expect(seen.title).toBe(m.title);
  expect(seen.priceMinor).toBe(m.priceMinor);
  const pub = await r.t.http().get(`/api/products/${r.id}`);
  expect(pub.status).toBe(m.status === 'ARCHIVED' ? 404 : 200); // R3
  expect(await productEvents(r.t.app, r.id)).toHaveLength(m.version); // R4: create + one per change
  expect(await impossibleProductRows(r.t.app)).toEqual(NOTHING_IMPOSSIBLE);
}

type Cmd = fc.AsyncCommand<Model, Real>;

class Edit implements Cmd {
  constructor(
    private readonly field: 'title' | 'quantity' | 'priceMinor',
    private readonly value: string | number,
    private readonly stale: boolean,
  ) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const expectedVersion = this.stale ? m.version + 1 : m.version;
    const res = await r.t
      .as(r.w.staff)
      .patch(path(r))
      .send({ expectedVersion, [this.field]: this.value });
    if (this.stale) {
      expect(res.status).toBe(409); // R5
    } else if (m.status === 'ARCHIVED') {
      expect(res.status).toBeGreaterThanOrEqual(400); // an archived product cannot be edited (R5)
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(200);
      if (m[this.field] !== this.value) {
        (m as unknown as Record<string, unknown>)[this.field] = this.value;
        m.version += 1; // R1: exactly one step per accepted change; an unchanged edit does not move the version
      }
    }
    await checkRules(m, r);
  }
  toString = () =>
    `edit ${this.field}=${this.value}${this.stale ? ' (stale version)' : ''}`;
}

class Archive implements Cmd {
  constructor(private readonly stale: boolean) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const res = await r.t
      .as(r.w.staff)
      .post(`${path(r)}/archive`)
      .send({ expectedVersion: this.stale ? m.version + 1 : m.version });
    if (this.stale) expect(res.status).toBe(409);
    else if (m.status === 'ARCHIVED') {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(200);
      m.status = 'ARCHIVED';
      m.version += 1;
    }
    await checkRules(m, r);
  }
  toString = () => `archive${this.stale ? ' (stale version)' : ''}`;
}

class Restore implements Cmd {
  constructor(private readonly stale: boolean) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const res = await r.t
      .as(r.w.staff)
      .post(`${path(r)}/restore`)
      .send({ expectedVersion: this.stale ? m.version + 1 : m.version });
    if (this.stale) expect(res.status).toBe(409);
    else if (m.status === 'ACTIVE') {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(200);
      m.status = 'ACTIVE';
      m.version += 1;
    }
    await checkRules(m, r);
  }
  toString = () => `restore${this.stale ? ' (stale version)' : ''}`;
}

/** A negative stock must be refused and change nothing (R2, R5). */
class NegativeStock implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    const res = await r.t
      .as(r.w.staff)
      .patch(path(r))
      .send({ expectedVersion: m.version, quantity: -1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await checkRules(m, r);
  }
  toString = () => 'set stock to -1 (must be refused)';
}

const title = fc.stringMatching(/^[A-Za-z0-9]{3,24}$/);
const commands = fc.commands(
  [
    fc.tuple(title, fc.boolean()).map(([v, s]) => new Edit('title', v, s)),
    fc.tuple(fc.integer({ min: 0, max: 500 }), fc.boolean()).map(([v, s]) => new Edit('quantity', v, s)),
    fc.tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.boolean()).map(([v, s]) => new Edit('priceMinor', v, s)),
    fc.boolean().map((s) => new Archive(s)),
    fc.boolean().map((s) => new Restore(s)),
    fc.constant(new NegativeStock()),
  ],
  { maxCommands: 14 },
);

describe('Product lifecycle, random sequences (stateful)', () => {
  let t: CatalogTestApp;
  beforeAll(async () => {
    t = await createCatalogApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  it('S05 AS-10, AS-11, AS-16, AS-17: after every random action version, stock, buyer visibility and events match the model', async () => {
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        // a shop per run: one shop's plan caps its live products (J02 FR-010), which a run of 15 would reach
        const w = await createShopWorld(t);
        const body = {
          title: 'Wool coat',
          description: 'Warm',
          brand: 'Nord',
          category: 'coats',
          priceMinor: 12_900,
          quantity: 5,
          tags: ['winter'],
        };
        const created = (await t.as(w.staff).post(`/api/shops/${w.shop.id}/products`).send(body).expect(201)).body as { id: string; version: number };
        const model: Model = { version: created.version, status: 'ACTIVE', title: body.title, quantity: body.quantity, priceMinor: body.priceMinor };
        const real: Real = { t, w, id: created.id };
        await checkRules(model, real);
        await fc.asyncModelRun(() => ({ model, real }), cmds);
      }),
      { numRuns: 15, interruptAfterTimeLimit: 240_000 },
    );
  }, 300_000);
});
