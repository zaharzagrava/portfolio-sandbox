use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use redis::AsyncCommands;
use redis::Client as RedisClient;
use tracing::{error, warn};
use uuid::Uuid;

use crate::connections::OutboundSignal;
use crate::hub::channel_topic;
use crate::protocol::{ChannelEnvelope, ModerationEvent, ModerationEventKind, ServerEvent};
use crate::state::AppState;

/// Must match CHAT_MODERATION_REDIS_TOPIC in
/// packages/backend/libs/common/src/chat/chat.constants.ts.
pub const MODERATION_TOPIC: &str = "chat:moderation";

pub async fn publish_channel_event(
    conn: &mut redis::aio::MultiplexedConnection,
    channel_id: Uuid,
    envelope: &ChannelEnvelope,
) -> redis::RedisResult<()> {
    let topic = channel_topic(channel_id);
    let payload = serde_json::to_string(envelope).expect("ChannelEnvelope always serializes");
    conn.publish(topic, payload).await
}

/// Runs for the lifetime of the process. Every gateway instance subscribes
/// to this one global, low-volume topic so a ban/mute takes effect
/// immediately everywhere - not just on instances that already happen to
/// have a local subscriber for the affected channel.
pub fn spawn_moderation_listener(redis: RedisClient, state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            match run_moderation_listener(&redis, &state).await {
                Ok(()) => warn!("moderation listener stream ended, reconnecting"),
                Err(err) => error!(%err, "moderation listener errored, reconnecting"),
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn run_moderation_listener(
    redis: &RedisClient,
    state: &Arc<AppState>,
) -> redis::RedisResult<()> {
    let mut pubsub = redis.get_async_pubsub().await?;
    pubsub.subscribe(MODERATION_TOPIC).await?;
    let mut stream = pubsub.on_message();

    while let Some(msg) = stream.next().await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(err) => {
                warn!(%err, "moderation listener: non-string payload");
                continue;
            }
        };

        let event: ModerationEvent = match serde_json::from_str(&payload) {
            Ok(e) => e,
            Err(err) => {
                warn!(%err, %payload, "moderation listener: failed to parse event");
                continue;
            }
        };

        state.member_cache.evict(event.channel_id, event.user_id);

        match event.kind {
            ModerationEventKind::Ban => {
                state.connections.notify_user(
                    event.user_id,
                    OutboundSignal::ForceUnsubscribe(event.channel_id),
                );
            }
            ModerationEventKind::Mute => {
                if let Some(muted_until) = event.muted_until {
                    state.connections.notify_user(
                        event.user_id,
                        OutboundSignal::Event(ServerEvent::Muted {
                            channel_id: event.channel_id,
                            muted_until,
                        }),
                    );
                }
            }
            // Unban/unmute/promote/demote only need the cache eviction above
            // so the next DB-backed check reflects the change - nothing to
            // push to a live connection.
            ModerationEventKind::Unban
            | ModerationEventKind::Unmute
            | ModerationEventKind::Promote
            | ModerationEventKind::Demote => {}
        }
    }

    Ok(())
}
