use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::Client as RedisClient;
use sqlx::PgPool;

use crate::cache::MemberCache;
use crate::connections::Connections;
use crate::hub::Hub;

/// TTL for the membership cache. Short enough that a stale ACTIVE entry
/// can't be ridden out for long even if an eviction is somehow missed; the
/// moderation listener evicting proactively is what makes bans/mutes feel
/// instant in practice, this is just the backstop.
const MEMBER_CACHE_TTL: Duration = Duration::from_secs(30);

/// Deliberately not Clone - every caller shares this through Arc<AppState>
/// (see main.rs), so a per-field Clone impl would just be dead weight (and
/// MemberCache/Connections/Hub hold their own Arc-wrapped interior state
/// for the handful of fields that do need cheap cloning at their call sites).
pub struct AppState {
    pub pg: PgPool,
    /// Cloned per publish call-site - MultiplexedConnection is designed for
    /// exactly that (cheap clone, safe concurrent use), no external locking
    /// needed.
    pub redis_publish: MultiplexedConnection,
    pub jwt_secret: String,
    pub hub: Hub,
    pub member_cache: MemberCache,
    pub connections: Connections,
}

impl AppState {
    pub fn new(
        pg: PgPool,
        redis_client: RedisClient,
        redis_publish: MultiplexedConnection,
        jwt_secret: String,
    ) -> Self {
        Self {
            pg,
            redis_publish,
            jwt_secret,
            hub: Hub::new(redis_client),
            member_cache: MemberCache::new(MEMBER_CACHE_TTL),
            connections: Connections::new(),
        }
    }
}
