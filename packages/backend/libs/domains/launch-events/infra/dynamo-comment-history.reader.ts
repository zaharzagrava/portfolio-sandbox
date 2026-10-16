import { Injectable } from '@nestjs/common';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type { LiveComment } from '../domain/live-constants';
import {
  commentPk,
  commentTimeMs,
  historyPk,
} from '../domain/live-history-keys';
import type { CommentHistoryReader, HistoryPage } from '../domain/live-ports';

interface HistoryItem {
  PK: string;
  SK: string;
  authorId?: string;
  authorName?: string;
  text?: string;
  at?: number;
  priority?: boolean;
  removed?: boolean;
}

const toCursor = (commentId: string) =>
  Buffer.from(commentId, 'utf8').toString('base64url');
const fromCursor = (cursor: string) =>
  Buffer.from(cursor, 'base64url').toString('utf8');

/** Reads the history written by `LiveCommentsProjector` (key design in `dynamodb/LiveComments.json`). */
@Injectable()
export class DynamoCommentHistoryReader implements CommentHistoryReader {
  constructor(private readonly dynamo: DynamoService) {}

  async exists(streamId: string, commentId: string): Promise<boolean> {
    const res = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.dynamo.table('LiveComments'),
        Key: {
          PK: commentPk(streamId, commentTimeMs(commentId)),
          SK: commentId,
        },
      }),
    );
    // A removal that arrived before its comment leaves a marker without text: that is not a comment.
    return typeof res.Item?.text === 'string';
  }

  async page(input: {
    streamId: string;
    minute: string;
    limit: number;
    cursor?: string;
  }): Promise<HistoryPage> {
    const table = this.dynamo.table('LiveComments');
    const pk = historyPk(input.streamId, input.minute);
    const after = input.cursor ? fromCursor(input.cursor) : undefined;
    const items: HistoryItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    // The filter runs after the read limit: keep reading until the page is full (plus one, to know there is more).
    do {
      const res = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: after
            ? 'PK = :pk AND SK > :after'
            : 'PK = :pk',
          FilterExpression:
            'attribute_exists(#text) AND attribute_not_exists(removed)',
          ExpressionAttributeNames: { '#text': 'text' },
          ExpressionAttributeValues: {
            ':pk': pk,
            ...(after && { ':after': after }),
          },
          ScanIndexForward: true,
          Limit: input.limit + 1,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((res.Items ?? []) as HistoryItem[]));
      startKey = res.LastEvaluatedKey;
    } while (items.length <= input.limit && startKey);

    const page = items.slice(0, input.limit);
    const comments: LiveComment[] = page.map((item) => ({
      id: item.SK,
      streamId: input.streamId,
      authorId: item.authorId as string,
      authorName: item.authorName as string,
      text: item.text as string,
      at: item.at as number,
      ...(item.priority && { priority: true as const }),
    }));
    return {
      items: comments,
      nextCursor:
        items.length > input.limit && page.length > 0
          ? toCursor(page[page.length - 1].SK)
          : null,
    };
  }
}
