use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures_util::StreamExt;
use redis::Client as RedisClient;
use tokio::sync::broadcast;
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::protocol::ChannelEnvelope;

const LOCAL_BROADCAST_CAPACITY: usize = 256;
const CLEANUP_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Must match chatChannelRedisTopic() in
/// packages/backend/libs/common/src/chat/chat.constants.ts.
pub fn channel_topic(channel_id: Uuid) -> String {
    format!("chat:channel:{channel_id}")
}

type Entries = Arc<DashMap<Uuid, broadcast::Sender<Arc<ChannelEnvelope>>>>;

/// In-process fan-out for chat channels, backed by Redis as the
/// cross-instance backplane. This instance subscribes to a channel's Redis
/// topic only while it has at least one local WebSocket subscriber for that
/// channel - not for every channel that exists - so idle channels cost
/// nothing and a fleet of instances doesn't all pay for every channel's
/// traffic regardless of where its participants are connected.
#[derive(Clone)]
pub struct Hub {
    entries: Entries,
    redis: RedisClient,
}

impl Hub {
    pub fn new(redis: RedisClient) -> Self {
        Self {
            entries: Arc::new(DashMap::new()),
            redis,
        }
    }

    /// Registers local interest in a channel and returns a receiver for its
    /// events. The first subscriber for a given channel_id on this instance
    /// spawns the redis-forwarding task; later subscribers just attach to
    /// the existing broadcast sender.
    pub fn subscribe(&self, channel_id: Uuid) -> broadcast::Receiver<Arc<ChannelEnvelope>> {
        let sender = self
            .entries
            .entry(channel_id)
            .or_insert_with(|| {
                let (tx, _rx) = broadcast::channel(LOCAL_BROADCAST_CAPACITY);
                spawn_forwarder(self.redis.clone(), self.entries.clone(), channel_id, tx.clone());
                tx
            })
            .clone();

        sender.subscribe()
    }
}

fn spawn_forwarder(redis: RedisClient, entries: Entries, channel_id: Uuid, tx: broadcast::Sender<Arc<ChannelEnvelope>>) {
    tokio::spawn(async move {
        let topic = channel_topic(channel_id);

        let mut pubsub = match redis.get_async_pubsub().await {
            Ok(p) => p,
            Err(err) => {
                error!(%channel_id, %err, "hub: failed to open redis pubsub connection");
                // Known limitation: if a subscriber is already attached to
                // this entry when we bail here, they're left with a receiver
                // that will never get anything until someone re-subscribes
                // and a fresh forwarder spins up. Acceptable for a redis
                // connectivity blip; not retried automatically.
                entries.remove_if(&channel_id, |_, existing| existing.receiver_count() == 0);
                return;
            }
        };

        if let Err(err) = pubsub.subscribe(&topic).await {
            error!(%channel_id, %err, "hub: failed to subscribe to redis topic");
            entries.remove_if(&channel_id, |_, existing| existing.receiver_count() == 0);
            return;
        }

        debug!(%channel_id, "hub: subscribed to redis topic");

        {
            let mut stream = pubsub.on_message();
            let mut cleanup = tokio::time::interval(CLEANUP_POLL_INTERVAL);
            cleanup.tick().await; // first tick fires immediately; skip it

            loop {
                tokio::select! {
                    msg = stream.next() => {
                        let Some(msg) = msg else {
                            warn!(%channel_id, "hub: redis pubsub stream ended");
                            break;
                        };
                        let payload: String = match msg.get_payload() {
                            Ok(p) => p,
                            Err(err) => {
                                warn!(%channel_id, %err, "hub: non-string redis payload");
                                continue;
                            }
                        };
                        match serde_json::from_str::<ChannelEnvelope>(&payload) {
                            Ok(envelope) => {
                                let _ = tx.send(Arc::new(envelope));
                            }
                            Err(err) => {
                                warn!(%channel_id, %err, %payload, "hub: failed to parse channel envelope");
                            }
                        }
                    }
                    _ = cleanup.tick() => {
                        if tx.receiver_count() == 0 {
                            break;
                        }
                    }
                }
            }
        }

        entries.remove_if(&channel_id, |_, existing| existing.receiver_count() == 0);
        let _ = pubsub.unsubscribe(&topic).await;
        debug!(%channel_id, "hub: torn down redis subscription");
    });
}
