import { INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { DevMailboxController } from './api/dev-mailbox.controller';
import { TransactionalMailService } from './application/transactional-mail.service';
import { memoryMailbox } from './infra/providers/memory-email.provider';
import { TransactionalMailModule } from './transactional-mail.module';

@Module({
  imports: [TransactionalMailModule],
  controllers: [DevMailboxController],
})
class MailboxSpecModule {}

describe('Dev mailbox', () => {
  let app: INestApplication;
  let mail: TransactionalMailService;
  const saved = {
    provider: process.env.EMAIL_PROVIDER,
    flag: process.env.DEV_MAILBOX_ENABLED,
    nodeEnv: process.env.NODE_ENV,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeAll(async () => {
    process.env.EMAIL_PROVIDER = 'memory';
    const moduleRef = await generateTestingModule([MailboxSpecModule]);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    mail = app.get(TransactionalMailService);
  });
  afterAll(async () => {
    await app.close();
    restore('EMAIL_PROVIDER', saved.provider);
    restore('DEV_MAILBOX_ENABLED', saved.flag);
    restore('NODE_ENV', saved.nodeEnv);
  });
  beforeEach(() => {
    memoryMailbox.clear();
    process.env.DEV_MAILBOX_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
  });

  const send = (to: string, token = 'abc') =>
    mail.sendResetLink({
      to,
      link: `http://localhost:3000/reset-password#token=${token}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  const mailbox = (to?: string) =>
    request(app.getHttpServer())
      .get('/api/dev/mailbox')
      .query(to ? { to } : {});

  it('dev-mailbox: disabled by default is 404 and shows nothing', async () => {
    await send('a@example.com');
    delete process.env.DEV_MAILBOX_ENABLED;
    await mailbox().expect(404);
    process.env.DEV_MAILBOX_ENABLED = 'false';
    await mailbox().expect(404);
  });

  it('dev-mailbox: enabled returns the reset mail with its text and the links found in it', async () => {
    await send('a@example.com', 'tok-1');
    const res = await mailbox().expect(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({
      to: 'a@example.com',
      subject: 'Reset your password',
      links: ['http://localhost:3000/reset-password#token=tok-1'],
    });
    expect(res.body.messages[0].text).toContain('tok-1');
  });

  it('dev-mailbox: NODE_ENV=production is 404 even when the flag is on', async () => {
    await send('a@example.com');
    process.env.NODE_ENV = 'production';
    await mailbox().expect(404);
  });

  it('dev-mailbox: the to filter keeps only that address (case-insensitive)', async () => {
    await send('one@example.com');
    await send('two@example.com');
    const res = await mailbox('TWO@example.com').expect(200);
    expect(res.body.messages.map((m: { to: string }) => m.to)).toEqual([
      'two@example.com',
    ]);
    const none = await mailbox('nobody@example.com').expect(200);
    expect(none.body.messages).toEqual([]);
  });

  it('dev-mailbox: keeps the 50 newest messages, newest first', async () => {
    for (let i = 0; i < 55; i++) await send('bulk@example.com', `t${i}`);
    const res = await mailbox().expect(200);
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].links[0]).toContain('token=t54');
    expect(res.body.messages[49].links[0]).toContain('token=t5');
  });
});
