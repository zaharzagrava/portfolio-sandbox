import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { createHash } from 'node:crypto';
import { parse, validate } from 'graphql';
import { BffSettings } from '../bff-config';
import { checkArguments } from './inputs';
import { analyzeQuery } from './limits';

export const TRUSTED_DOCUMENT_ENTRIES = Symbol('TRUSTED_DOCUMENT_ENTRIES');

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/**
 * The allow-list of documents the BFF executes (S48 FR-036, AS-37, AS-39). Keys are the SHA-256 of the text; both the
 * key check and the validation against the schema and the query limits run at startup, and a bad entry stops the
 * process naming the entry (its hash prefix, never its text). There is no way to add an entry at run time.
 */
@Injectable()
export class TrustedDocuments implements OnApplicationBootstrap {
  private readonly documents = new Map<string, string>();

  constructor(
    @Inject(TRUSTED_DOCUMENT_ENTRIES) entries: Record<string, string>,
    private readonly settings: BffSettings,
    private readonly schemaHost: GraphQLSchemaHost,
  ) {
    for (const [hash, text] of Object.entries(entries)) {
      if (sha256Hex(text) !== hash)
        throw new Error(
          `Trusted document ${hash.slice(0, 12)}: the key is not the SHA-256 of its document`,
        );
      this.documents.set(hash, text);
    }
  }

  onApplicationBootstrap(): void {
    const { schema } = this.schemaHost;
    for (const [hash, text] of this.documents) {
      const name = `Trusted document ${hash.slice(0, 12)}`;
      let document;
      try {
        document = parse(text);
      } catch {
        throw new Error(`${name}: the document does not parse`);
      }
      const errors = validate(schema, document);
      if (errors.length > 0)
        throw new Error(
          `${name}: the document does not validate against the schema (${errors[0].message})`,
        );
      const verdict = analyzeQuery(document, {}, undefined, {
        maxDepth: this.settings.graphql.maxDepth,
        maxCost: this.settings.graphql.maxCost,
        maxRootFields: this.settings.graphql.maxRootFields,
        maxIds: this.settings.graphql.maxIds,
      });
      if (!verdict.ok)
        throw new Error(
          `${name}: the document exceeds a query limit (${verdict.code})`,
        );
      const input = checkArguments(document, {}, this.settings.graphql.maxIds);
      if (input && input.argument !== 'id' && input.argument !== 'ids')
        throw new Error(`${name}: ${input.message}`);
    }
  }

  get(hash: string): string | undefined {
    return this.documents.get(hash);
  }

  get size(): number {
    return this.documents.size;
  }
}
