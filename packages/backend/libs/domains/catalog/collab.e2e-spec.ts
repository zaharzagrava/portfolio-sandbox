import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ShopModel as Shop, ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import Product from './infra/models/product.model';
import { CollabModule } from './collab.module';
import { DraftsModule } from './drafts.module';
import { CollabInstanceRegistry } from './infra/instance-registry';
import { DraftsService } from './application/drafts.service';
import { DraftStore } from './infra/draft-store';
import { readListing } from './domain/listing-doc';
import { signCollabTicket } from './infra/collab-ticket';
import { MESSAGE_SYNC } from './application/room';

@Module({ imports: [CollabModule, DraftsModule, SequelizeModule.forFeature([Shop, ShopMembership, Product])] })
class SpecModule {}

/** Minimal y-websocket client: sync handshake + forwarding local updates. */
class YClient {
  readonly doc = new Y.Doc();
  synced = false;
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: ArrayBuffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });
    this.ws.on('close', (code, reason) => (this.closed = { code, reason: reason.toString() }));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    });
  }

  private onMessage(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return; // awareness ignored here
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (type === syncProtocol.messageYjsSyncStep2) this.synced = true;
    if (encoding.length(encoder) > 1) this.ws.send(encoding.toUint8Array(encoder));
  }

  title() {
    return this.doc.getText('title').toString();
  }

  close() {
    this.ws.close();
  }
}

/** SD-16 against real Postgres + Redis + DynamoDB Local + MinIO, over real WebSockets. */
describe('Collaborative listing drafts (e2e)', () => {
  let app: INestApplication;
  let wsBase: string;
  let seeds: SeedsService;
  let drafts: DraftsService;
  let secret: string;
  const clients: YClient[] = [];

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['redis', 'dynamo', 'storage'] });
    app = moduleRef.createNestApplication();
    await app.listen(0);
    wsBase = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    seeds = app.get(SeedsService);
    drafts = app.get(DraftsService);
    secret = app.get(ApiConfigService).get('jwt_secret');
  });

  afterEach(() => clients.splice(0).forEach((c) => c.close()));

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    // The cleanup flushed Redis, including the collab server's registry entry (its own instance, not DraftsModule's).
    await app.select(CollabModule).get(CollabInstanceRegistry, { strict: true }).heartbeatNow();
  });

  const setup = async () => {
    const [owner, viewer] = await seeds.createTreelike([{ __type__: TableName.User }, { __type__: TableName.User }]);
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Shop', slug: `s-${v4().slice(0, 8)}` });
    await app.get<typeof ShopMembership>(getModelToken(ShopMembership)).bulkCreate([
      { shopId: shop.id, userId: owner.id, role: 'OWNER' },
      { shopId: shop.id, userId: viewer.id, role: 'VIEWER' },
    ]);
    const draft = await drafts.create(shop.id, owner.id, 'iPhone 17 listing');
    return { draftId: draft.id, shopId: shop.id, owner: owner.id as string, viewer: viewer.id as string };
  };

  const connect = (draftId: string, userId: string, canWrite: boolean) => {
    const client = new YClient(`${wsBase}/collab/${draftId}?ticket=${signCollabTicket({ userId, draftId, canWrite }, secret)}`);
    clients.push(client);
    return client;
  };

  it('concurrent edits from two editors converge, and the persisted state (snapshot + tail) equals the live doc', async () => {
    const { draftId, owner } = await setup();
    const a = connect(draftId, owner, true);
    const b = connect(draftId, owner, true);
    await waitFor(async () => a.synced && b.synced, { description: 'both synced' });

    a.doc.getText('title').insert(0, 'iPhone 17 Pro');
    b.doc.getText('title').insert(0, 'NEW: ');
    a.doc.getMap('fields').set('price', 129_900);
    b.doc.getMap('specs').set('Storage', '256 GB');

    await waitFor(async () => a.title() === b.title() && a.title().length === 'iPhone 17 Pro'.length + 'NEW: '.length, { description: 'convergence' });
    await waitFor(async () => b.doc.getMap('fields').get('price') === 129_900 && a.doc.getMap('specs').get('Storage') === '256 GB');

    // Persisted after the 100 ms flush: any process can rebuild the doc.
    const persisted = await waitFor(async () => {
      const { doc } = await app.get(DraftStore).load(draftId);
      return doc.getText('title').toString() === a.title() && doc;
    });
    expect(readListing(persisted as Y.Doc)).toMatchObject({ price: 129_900, specs: { Storage: '256 GB' } });
  });

  it('a viewer receives edits but its own writes are dropped server-side', async () => {
    const { draftId, owner, viewer } = await setup();
    const editor = connect(draftId, owner, true);
    const reader = connect(draftId, viewer, false);
    await waitFor(async () => editor.synced && reader.synced);

    editor.doc.getText('title').insert(0, 'Official title');
    await waitFor(async () => reader.title() === 'Official title');

    reader.doc.getText('title').insert(0, 'HACKED ');
    await new Promise((r) => setTimeout(r, 400));
    expect(editor.title()).toBe('Official title');
    expect((await app.get(DraftStore).load(draftId)).doc.getText('title').toString()).toBe('Official title');
  });

  it('connect() hands viewers a read-only ticket; bad tickets are refused at the handshake', async () => {
    const { draftId, viewer, owner } = await setup();
    expect((await drafts.connect(draftId, viewer)).canWrite).toBe(false);
    expect((await drafts.connect(draftId, owner)).canWrite).toBe(true);
    await expect(drafts.connect(draftId, v4())).rejects.toMatchObject({ status: 404 });

    const forged = new WebSocket(`${wsBase}/collab/${draftId}?ticket=${signCollabTicket({ userId: owner, draftId: v4(), canWrite: true }, secret)}`);
    const outcome = await new Promise<string>((resolve) => {
      forged.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      forged.on('open', () => resolve('opened'));
      forged.on('error', () => resolve('error'));
    });
    expect(outcome).toBe('401');
  });

  it('publish turns the CRDT into a product and freezes a version', async () => {
    const { draftId, shopId, owner } = await setup();
    const editor = connect(draftId, owner, true);
    await waitFor(async () => editor.synced);
    editor.doc.transact(() => {
      editor.doc.getText('title').insert(0, 'AirPods Pro 3');
      editor.doc.getText('description').insert(0, 'Adaptive audio.');
      editor.doc.getMap('fields').set('price', 24_900);
      editor.doc.getMap('fields').set('category', 'audio');
    });
    await new Promise((r) => setTimeout(r, 300)); // > flush interval

    const { productId } = await drafts.publish(draftId, owner);
    const product = await app.get<typeof Product>(getModelToken(Product)).findByPk(productId!);
    expect(product).toMatchObject({ title: 'AirPods Pro 3', category: 'audio', shopId });
    expect(Number(product!.price)).toBe(24_900);
    expect(product!.description).toContain('Adaptive audio.');
    const versions = (await drafts.versions(draftId)) as { name: string }[];
    expect(versions[0].name).toMatch(/^Published /);
    expect(productId).toBeTruthy();
    await expect(drafts.publish(draftId, owner)).rejects.toMatchObject({ status: 400 });
    expect((await drafts.list(shopId))[0]).toMatchObject({ status: 'PUBLISHED', productId });
  });
});
