import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createToolkitApp } from './test-app';

describe('toolkit test harness', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createToolkitApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('boots the real toolkit modules and a route answers', async () => {
    const res = await request(app.getHttpServer()).get('/t/ok').expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
