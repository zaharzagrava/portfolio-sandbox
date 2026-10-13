import {
  commentRepliesPageSchema,
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
  voteResultSchema,
} from '@marketplace-sandbox/contracts';
import type { CommentView, PostView } from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

// Typed with the contracts views the services return: a drift in a field name or type fails `tsc`.
const servicePost: PostView = {
  postId: '0b5f6f0e-1111-4222-8333-444455556666',
  boardId: '1c5f6f0e-1111-4222-8333-444455556666',
  authorId: '2d5f6f0e-1111-4222-8333-444455556666',
  title: 'Does it work with USB-C?',
  bodyHtml: '<p>Planning to use it with a <strong>laptop</strong>.</p>',
  createdAt: '2026-10-10T12:00:00.000Z',
  ups: 3,
  downs: 1,
  score: 2,
  commentCount: 2,
  myVote: null,
};
const serviceComment: CommentView = {
  commentId: '3e5f6f0e-1111-4222-8333-444455556666',
  postId: servicePost.postId,
  parentId: null,
  depth: 0,
  authorId: servicePost.authorId,
  bodyHtml: '<p>Yes.</p>',
  createdAt: '2026-10-10T12:05:00.000Z',
  ups: 1,
  downs: 0,
  score: 1,
  myVote: 1,
  deleted: false,
  replyCount: 0,
};

const post = servicePost;
const comment = serviceComment;

describe('W02 B-7: discussion contracts', () => {
  it('W02 B-7: a board page built from the real post view parses, with and without degraded', () => {
    expect(ok(postPageSchema, { items: [post], nextCursor: null })).toBe(true);
    expect(
      ok(postPageSchema, { items: [post], nextCursor: '25', degraded: true }),
    ).toBe(true);
    expect(ok(postViewSchema, post)).toBe(true);
  });

  it('W02 B-7: post negatives: legacy envelope, missing counts, bad myVote, degraded false', () => {
    expect(ok(postPageSchema, { posts: [post], next: '25' })).toBe(false);
    expect(ok(postViewSchema, { ...post, commentCount: undefined })).toBe(
      false,
    );
    expect(ok(postViewSchema, { ...post, myVote: 2 })).toBe(false);
    expect(ok(postViewSchema, { ...post, ups: -1 })).toBe(false);
    expect(
      ok(postPageSchema, { items: [post], nextCursor: null, degraded: false }),
    ).toBe(false);
  });

  it('W02 B-7: a comment thread parses nodes with replies and tombstones', () => {
    const tombstone = {
      ...comment,
      commentId: 'tomb',
      deleted: true,
      deletedBy: 'moderator',
      authorId: null,
      bodyHtml: '',
    };
    const node = {
      ...comment,
      replies: [
        { ...comment, parentId: comment.commentId, depth: 1 },
        tombstone,
      ],
      hasMoreReplies: true,
    };
    expect(
      ok(commentThreadPageSchema, { items: [node], nextCursor: null }),
    ).toBe(true);
    expect(
      ok(commentThreadPageSchema, { items: [comment], nextCursor: null }),
    ).toBe(false);
    expect(ok(commentThreadPageSchema, [node])).toBe(false);
    expect(
      ok(commentThreadPageSchema, {
        items: [{ ...node, replies: [{ ...comment, deletedBy: 'bot' }] }],
        nextCursor: null,
      }),
    ).toBe(false);
  });

  it('W02 B-7: a replies page parses flat comment views', () => {
    expect(
      ok(commentRepliesPageSchema, {
        items: [comment, comment],
        nextCursor: 'c1',
      }),
    ).toBe(true);
    expect(
      ok(commentRepliesPageSchema, {
        items: [{ ...comment, depth: -1 }],
        nextCursor: null,
      }),
    ).toBe(false);
    expect(ok(commentRepliesPageSchema, { items: [comment] })).toBe(false);
  });

  it('W02 B-7: a vote result carries targetId, targetType, counts, score and myVote', () => {
    const vote = {
      targetId: servicePost.postId,
      targetType: 'post',
      ups: 1,
      downs: 0,
      score: 1,
      myVote: 1,
    };
    expect(ok(voteResultSchema, vote)).toBe(true);
    expect(ok(voteResultSchema, { ...vote, myVote: 0 })).toBe(true);
    expect(ok(voteResultSchema, { ups: 1, downs: 0, myVote: 1 })).toBe(false);
    expect(ok(voteResultSchema, { ...vote, targetType: 'user' })).toBe(false);
    expect(ok(voteResultSchema, { ...vote, myVote: 5 })).toBe(false);
  });
});
