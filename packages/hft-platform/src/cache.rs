use std::time::{Duration, Instant};

use dashmap::DashMap;
use uuid::Uuid;

use crate::db::Membership;

/// Per-(channel, user) membership cache so a hot send/subscribe path doesn't
/// hit Postgres every time. Entries expire on their own after `ttl`, but the
/// moderation listener also evicts proactively on ban/mute/unban/promote so
/// a hostile actor can't just wait out the TTL after being banned - the
/// eviction is what makes enforcement immediate, the TTL is just a backstop
/// for entries nobody evicted (e.g. this instance missed the pub/sub message
/// briefly during a reconnect).
pub struct MemberCache {
    inner: DashMap<(Uuid, Uuid), (Membership, Instant)>,
    ttl: Duration,
}

impl MemberCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: DashMap::new(),
            ttl,
        }
    }

    pub fn get(&self, channel_id: Uuid, user_id: Uuid) -> Option<Membership> {
        let entry = self.inner.get(&(channel_id, user_id))?;
        let (membership, cached_at) = entry.value();
        if cached_at.elapsed() > self.ttl {
            return None;
        }
        Some(membership.clone())
    }

    pub fn put(&self, channel_id: Uuid, user_id: Uuid, membership: Membership) {
        self.inner
            .insert((channel_id, user_id), (membership, Instant::now()));
    }

    pub fn evict(&self, channel_id: Uuid, user_id: Uuid) {
        self.inner.remove(&(channel_id, user_id));
    }
}
