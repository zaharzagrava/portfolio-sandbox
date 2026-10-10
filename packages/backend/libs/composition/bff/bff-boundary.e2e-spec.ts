import { createHash, randomBytes } from 'node:crypto';
import { createBffApp } from './testing/app-factory';
import { StubUpstream } from './testing/stub-upstream';
import { PERSISTED_QUERIES } from './graphql/persisted-queries.allowlist';
import { TRUSTED_DOCUMENT_ENTRIES } from './graphql/trusted-documents';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('BFF composition boundary', () => {
  let stub: StubUpstream;
  beforeAll(async () => {
    stub = await StubUpstream.start();
  });
  afterAll(async () => stub.close());

  const boot = (entries: Record<string, string>) =>
    createBffApp({
      upstreamUrl: stub.url,
      configure: (builder) =>
        builder.overrideProvider(TRUSTED_DOCUMENT_ENTRIES).useValue(entries),
    });
  const failureOf = async (
    start: Promise<{ close(): Promise<void> }>,
  ): Promise<string> => {
    try {
      await (await start).close();
    } catch (e) {
      return String((e as Error).message);
    }
    throw new Error('expected the application not to start');
  };

  describe('S48 AS-39 allow-list integrity at startup', () => {
    it('S48 AS-39: the shipped allow-list starts', async () => {
      const app = await boot(PERSISTED_QUERIES);
      await app.close();
    });

    it('S48 AS-39: a key that is not the SHA-256 of its document stops the process and names the entry', async () => {
      const text = '{ __typename }';
      const wrongKey = sha256('something else');
      const message = await failureOf(boot({ [wrongKey]: text }));
      expect(message).toContain(wrongKey.slice(0, 12));
      expect(message).toMatch(/SHA-256/);
    });

    it('S48 AS-39: a document that does not validate against the schema stops the process and names the entry', async () => {
      const text =
        '{ product(id: "00000000-0000-4000-8000-000000000000") { noSuchField } }';
      const key = sha256(text);
      const message = await failureOf(boot({ [key]: text }));
      expect(message).toContain(key.slice(0, 12));
      expect(message).toMatch(/validate/);
    });

    it('S48 AS-39: a document that exceeds a query limit stops the process and names the entry', async () => {
      const ids = Array.from(
        { length: 11 },
        (_, i) =>
          `a${i}: product(id: "00000000-0000-4000-8000-000000000000") { recommendations(first: 50) { recommendations(first: 50) { id } } }`,
      ).join(' ');
      const text = `{ ${ids} }`;
      const key = sha256(text);
      const message = await failureOf(boot({ [key]: text }));
      expect(message).toContain(key.slice(0, 12));
      expect(message).toMatch(/limit/);
    });
  });

  describe('S48 AS-63 startup validation', () => {
    const start = (env: Record<string, string | undefined>) =>
      createBffApp({ upstreamUrl: stub.url, env });

    it('S48 AS-63: a missing or malformed upstream url stops the process; there is no localhost default', async () => {
      expect(await failureOf(start({ BFF_UPSTREAM_URL: undefined }))).toMatch(
        /bff_upstream_url/,
      );
      expect(await failureOf(start({ BFF_UPSTREAM_URL: 'not a url' }))).toMatch(
        /bff_upstream_url/,
      );
    });

    it('S48 AS-63: bad session or CSRF keys stop the process without echoing them', async () => {
      const bad = randomBytes(8).toString('base64');
      const keys = await failureOf(start({ BFF_SESSION_KEYS: bad }));
      expect(keys).toMatch(/bff_session_keys/);
      expect(keys).not.toContain(bad);
      expect(await failureOf(start({ BFF_CSRF_KEY: undefined }))).toMatch(
        /bff_csrf_key/,
      );
      expect(await failureOf(start({ BFF_ALLOWED_ORIGINS: '' }))).toMatch(
        /bff_allowed_origins/,
      );
    });
  });
});
