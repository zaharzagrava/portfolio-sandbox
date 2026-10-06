import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID as v4 } from 'crypto';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { AuthService, UserModel as User } from '@app/domains/identity';
import { getModelToken } from '@nestjs/sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { TableName } from '@app/test/seeds/types';
import { ChatModule } from './chat.module';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config/api-config.service';

describe('Chat (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let authService: AuthService;
  let configService: ApiConfigService;
  let userModel: typeof User;
  let productModel: typeof Product;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([ChatModule, RateLimitModule, CacheModule, SeedsModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    seedsService = app.get(SeedsService);
    authService = app.get(AuthService);
    configService = app.get(ApiConfigService);
    userModel = app.get(getModelToken(User));
    productModel = app.get(getModelToken(Product));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
  });

  it('mints a valid websocket ticket for the user', async () => {
    const user = await userModel.create({ email: `test-${v4()}@mail.com` });
    const token = authService.issueTokensFor(user).accessToken.token;

    const res = await request(app.getHttpServer())
      .post('/api/chat/ws-ticket')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    expect(res.body.ticket).toBeDefined();
    
    // Verify ticket
    const decoded = jwt.verify(res.body.ticket, configService.get('jwt_secret')) as any;
    expect(decoded.sub).toBe(user.id);
    expect(decoded.typ).toBe('ws');
  });

  it('allows a seller to create a channel for their product', async () => {
    const seller = await userModel.create({ email: `seller-${v4()}@mail.com` });
    const token = authService.issueTokensFor(seller).accessToken.token;

    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, sellerId: seller.id }]);

    const res = await request(app.getHttpServer())
      .post('/api/chat/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, title: 'Support Chat' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.productId).toBe(product.id);
    expect(res.body.myRole).toBe('OWNER');
  });

  it('prevents non-sellers from creating a channel', async () => {
    const seller = await userModel.create({ email: `seller-${v4()}@mail.com` });
    const buyer = await userModel.create({ email: `buyer-${v4()}@mail.com` });
    const buyerToken = authService.issueTokensFor(buyer).accessToken.token;

    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, sellerId: seller.id }]);

    await request(app.getHttpServer())
      .post('/api/chat/channels')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: product.id, title: 'Support Chat' })
      .expect(403);
  });

  it('allows owner to mute a member', async () => {
    const seller = await userModel.create({ email: `seller-${v4()}@mail.com` });
    const member = await userModel.create({ email: `member-${v4()}@mail.com` });
    const sellerToken = authService.issueTokensFor(seller).accessToken.token;

    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, sellerId: seller.id }]);

    // Create channel
    const channelRes = await request(app.getHttpServer())
      .post('/api/chat/channels')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ productId: product.id })
      .expect(201);

    const channelId = channelRes.body.id;

    // Mute member
    await request(app.getHttpServer())
      .post(`/api/chat/channels/${channelId}/members/mute`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ userId: member.id, minutes: 10 })
      .expect(201);
  });

  it('buyers join a product chat; joining is idempotent and a ban sticks', async () => {
    const seller = await userModel.create({ email: `seller-${v4()}@mail.com` });
    const buyer = await userModel.create({ email: `buyer-${v4()}@mail.com` });
    const sellerAuth = { Authorization: `Bearer ${authService.issueTokensFor(seller).accessToken.token}` };
    const buyerAuth = { Authorization: `Bearer ${authService.issueTokensFor(buyer).accessToken.token}` };
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, sellerId: seller.id }]);
    const channelId = (await request(app.getHttpServer()).post('/api/chat/channels').set(sellerAuth).send({ productId: product.id }).expect(201)).body.id;

    const joined = await request(app.getHttpServer()).post(`/api/chat/channels/${channelId}/join`).set(buyerAuth).expect(200);
    expect(joined.body.id).toBe(channelId);
    await request(app.getHttpServer()).post(`/api/chat/channels/${channelId}/join`).set(buyerAuth).expect(200);

    await request(app.getHttpServer()).post(`/api/chat/channels/${channelId}/members/ban`).set(sellerAuth).send({ userId: buyer.id }).expect(201);
    await request(app.getHttpServer()).post(`/api/chat/channels/${channelId}/join`).set(buyerAuth).expect(403);
  });
});
