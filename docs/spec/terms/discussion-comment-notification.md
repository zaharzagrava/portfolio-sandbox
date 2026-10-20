---
id: discussion-comment-notification
title: discussion.comment notification
kind: term
status: draft
aliases: [discussion.comment]
defined_for: J05-engagement-loop
rules_hash: f6153d149d11
---
# discussion.comment notification
## Definition
A `discussion.comment` notification tells a post's author that someone commented on their post. The comment's [`discussion.*` event](realtime-event.md) reaches the [Notifications capability](notification.md) (S28), which creates the [item](inbox-item.md). The author gets it exactly once; the commenter never gets a notification for their own comment.

## Example
The seller comments on buyer B's post. When B reads notifications, exactly one item of [type `discussion.comment`](notification-type.md) exists.

## Known gaps
- The spec does not say which [channels](notification-channel.md) (in-app, e-mail, push) deliver this notification.
- The spec does not say whether the author is notified when they comment on their own post.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
