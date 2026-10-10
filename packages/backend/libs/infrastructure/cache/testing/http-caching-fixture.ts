import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { VersionEtagInterceptor, withEtag } from '../etag.interceptor';
import { buildCacheControl } from '../cache-control';

/** The fixture's response contract (VII.6): every fixture route parses its body with this before replying. */
export const fixtureDocSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  tenant: z.string().min(1),
  title: z.string(),
});
export type FixtureDoc = z.infer<typeof fixtureDocSchema>;

/** In-memory documents owned by tenants; specs bump versions through it. Test code only: no domain, no table. */
@Injectable()
export class FixtureStore {
  private readonly docs = new Map<string, FixtureDoc>();

  put(doc: FixtureDoc): void {
    this.docs.set(doc.id, doc);
  }

  get(id: string): FixtureDoc | undefined {
    return this.docs.get(id);
  }

  bump(id: string): FixtureDoc {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`no fixture document ${id}`);
    const next = { ...doc, version: doc.version + 1 };
    this.docs.set(id, next);
    return next;
  }
}

/** Fixture routes behind the interceptor; the tenant comes from `x-tenant`, as a guard would have set it. */
@Controller('fixture')
@UseInterceptors(VersionEtagInterceptor)
export class HttpCachingFixtureController {
  constructor(private readonly store: FixtureStore) {}

  private owned(req: Request, id: string): FixtureDoc {
    const doc = this.store.get(id);
    // Another tenant's resource does not exist for this caller.
    if (!doc || doc.tenant !== req.headers['x-tenant'])
      throw new NotFoundException();
    return fixtureDocSchema.parse(doc);
  }

  @Get('docs/:id')
  doc(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ) {
    const doc = this.owned(req, id);
    res.setHeader(
      'Cache-Control',
      buildCacheControl({
        visibility: 'public',
        maxAgeSec: 60,
        sMaxAgeSec: 300,
      }),
    );
    res.setHeader('Cache-Tag', `doc-${doc.id}`);
    res.setHeader('Vary', 'Accept-Language');
    res.setHeader('Content-Language', 'en');
    res.setHeader('Content-Location', `/api/fixture/docs/${doc.id}`);
    return doc;
  }

  @Get('own-cache-control/:id')
  @Header('Cache-Control', 'private, max-age=5')
  ownCacheControl(@Req() req: Request, @Param('id') id: string) {
    return this.owned(req, id);
  }

  @Post('docs/:id')
  create(@Param('id') id: string) {
    return { id, version: 1, created: true };
  }

  @Put('docs/:id')
  replace(@Param('id') id: string) {
    return { id, version: 2 };
  }

  @Patch('docs/:id')
  patch(@Param('id') id: string, @Body() body: unknown) {
    return { id, version: 3, body };
  }

  @Delete('docs/:id')
  remove(@Param('id') id: string) {
    return { id, version: 4 };
  }

  @Get('story/:id')
  story(@Param('id') id: string) {
    return withEtag({ id, version: 2, locale: 'en' }, '"story-1-v2-en"');
  }

  @Get('bad-validator/:kind')
  badValidator(@Param('kind') kind: string) {
    const bad: Record<string, string> = {
      unquoted: 'story-1-v2-en',
      long: `"${'x'.repeat(300)}"`,
      control: '"a\u0001b"',
      space: '"a b"',
    };
    return withEtag({ id: 'story-1', version: 2 }, bad[kind] ?? kind);
  }

  @Get('no-version')
  noVersion() {
    return { id: 'a' };
  }

  @Get('no-id')
  noId() {
    return { version: 1 };
  }

  @Get('fractional-version')
  fractionalVersion() {
    return { id: 'a', version: 1.5 };
  }

  @Get('array')
  array() {
    return [{ id: 'a', version: 1 }];
  }

  @Get('stream')
  stream() {
    return new StreamableFile(
      Readable.from([JSON.stringify({ id: 'a', version: 1 })]),
      {
        type: 'application/json',
      },
    );
  }

  @Get('errors/:status')
  error(@Param('status') status: string) {
    switch (status) {
      case '401':
        throw new UnauthorizedException();
      case '403':
        throw new ForbiddenException();
      case '404':
        throw new NotFoundException();
      default:
        throw new Error('boom');
    }
  }
}

@Module({
  controllers: [HttpCachingFixtureController],
  providers: [FixtureStore, VersionEtagInterceptor],
  exports: [FixtureStore],
})
export class HttpCachingFixtureModule {}
