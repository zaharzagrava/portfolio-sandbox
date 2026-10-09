import { Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { PermanentError, TransientError } from '../errors';
import type { SinkCounts } from '../projector';

export interface EsVersionedDoc {
  id: string;
  /** The aggregate version, used as the external version: only a strictly greater one is stored. */
  version: number;
  doc: Record<string, unknown>;
}

export interface EsVersionedDelete {
  id: string;
  version: number;
}

const CONFLICT = 'version_conflict_engine_exception';
/** `... current version [3] is higher or equal to the one provided [3]` */
const CONFLICT_REASON =
  /current version \[(\d+)\] is (?:higher or equal to|higher than) the one provided \[(\d+)\]/;

interface BulkItem {
  status?: number;
  error?: { type?: string; reason?: string };
}

/**
 * Elasticsearch writes with external versioning (`version_type: external`): a document is stored only when its
 * version is strictly greater than the indexed one (S53 FR-043, gap G-33). A conflict is a skipped outcome, not an
 * error and not logged as a failure; the conflict reason tells `duplicate` (equal) from `stale` (older). Deletes
 * carry a version too, so a late older write cannot bring a deleted document back.
 *
 * Built on the current product-index client; it moves with the generic client of S32 (debt D-16).
 */
@Injectable()
export class EsVersionedSink {
  constructor(private readonly elasticsearch: ElasticsearchService) {}

  async bulkIfNewer(
    index: string,
    docs: EsVersionedDoc[],
    options: { refresh?: boolean } = {},
  ): Promise<SinkCounts> {
    return this.bulk(
      index,
      docs.flatMap((d) => [
        {
          index: {
            _index: index,
            _id: d.id,
            version: d.version,
            version_type: 'external' as const,
          },
        },
        d.doc,
      ]),
      options,
    );
  }

  async deleteIfNewer(
    index: string,
    deletes: EsVersionedDelete[],
    options: { refresh?: boolean } = {},
  ): Promise<SinkCounts> {
    return this.bulk(
      index,
      deletes.map((d) => ({
        delete: {
          _index: index,
          _id: d.id,
          version: d.version,
          version_type: 'external' as const,
        },
      })),
      options,
    );
  }

  private async bulk(
    index: string,
    operations: object[],
    { refresh = false }: { refresh?: boolean },
  ): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    if (operations.length === 0) return counts;
    let response;
    try {
      response = await this.elasticsearch
        .getClient()
        .bulk({ operations, refresh });
    } catch (error) {
      throw new TransientError(`Elasticsearch bulk to ${index} failed`, {
        cause: error,
      });
    }
    for (const item of response.items) {
      const result = (item.index ??
        item.delete ??
        item.create ??
        item.update) as BulkItem | undefined;
      if (!result?.error) {
        counts.applied++;
        continue;
      }
      if (result.error.type === CONFLICT) {
        const match = CONFLICT_REASON.exec(result.error.reason ?? '');
        if (match && match[1] === match[2]) counts.duplicate++;
        else counts.stale++;
        continue;
      }
      // A 404 on a delete means the document is already gone: the intended state.
      if (item.delete && result.status === 404) {
        counts.applied++;
        continue;
      }
      const retryable = result.status === 429 || (result.status ?? 0) >= 500;
      const detail = `Elasticsearch rejected a write to ${index} (${result.status}, ${result.error.type})`;
      throw retryable ? new TransientError(detail) : new PermanentError(detail);
    }
    return counts;
  }
}
