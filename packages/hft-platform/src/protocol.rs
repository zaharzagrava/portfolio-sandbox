use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A persisted chat message, shaped to match ChatMessage in
/// packages/backend/libs/common/src/models/chat-message.model.ts.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MessageDto {
    pub id: Uuid,
    #[serde(rename = "channelId")]
    pub channel_id: Uuid,
    #[serde(rename = "authorId")]
    pub author_id: Uuid,
    pub body: String,
    #[serde(rename = "replyToId")]
    pub reply_to_id: Option<Uuid>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
}

/// Frames sent by the browser over the WebSocket connection.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientOp {
    Subscribe {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    Unsubscribe {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    Send {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        body: String,
        #[serde(rename = "replyToId", default)]
        reply_to_id: Option<Uuid>,
    },
    Typing {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    Read {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "messageId")]
        message_id: Uuid,
    },
    Ping,
}

/// Frames sent from the gateway down to one specific connection.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    #[serde(rename = "subscribed")]
    Subscribed {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        role: String,
    },
    #[serde(rename = "unsubscribed")]
    Unsubscribed {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        message: MessageDto,
    },
    #[serde(rename = "message_deleted")]
    MessageDeleted {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "messageId")]
        message_id: Uuid,
    },
    #[serde(rename = "channel_archived")]
    ChannelArchived {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    #[serde(rename = "typing")]
    Typing {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    #[serde(rename = "banned")]
    Banned {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    #[serde(rename = "muted")]
    Muted {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "mutedUntil")]
        muted_until: DateTime<Utc>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    #[serde(rename = "pong")]
    Pong,
}

impl ServerEvent {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerEvent::Error {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// The redis pub/sub envelope for `chat:channel:{channelId}`
/// (see packages/backend/libs/common/src/chat/chat.constants.ts). NestJS
/// only ever publishes MessageDeleted/ChannelArchived; this gateway
/// publishes Message/Typing too and is the only reader that needs the full
/// set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ChannelEnvelope {
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        message: MessageDto,
    },
    #[serde(rename = "message_deleted")]
    MessageDeleted {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "messageId")]
        message_id: Uuid,
    },
    #[serde(rename = "channel_archived")]
    ChannelArchived {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
    },
    #[serde(rename = "typing")]
    Typing {
        #[serde(rename = "channelId")]
        channel_id: Uuid,
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
}

impl From<ChannelEnvelope> for ServerEvent {
    fn from(env: ChannelEnvelope) -> Self {
        match env {
            ChannelEnvelope::Message { channel_id, message } => {
                ServerEvent::Message { channel_id, message }
            }
            ChannelEnvelope::MessageDeleted {
                channel_id,
                message_id,
            } => ServerEvent::MessageDeleted {
                channel_id,
                message_id,
            },
            ChannelEnvelope::ChannelArchived { channel_id } => {
                ServerEvent::ChannelArchived { channel_id }
            }
            ChannelEnvelope::Typing { channel_id, user_id } => {
                ServerEvent::Typing { channel_id, user_id }
            }
        }
    }
}

/// The redis pub/sub envelope for the global `chat:moderation` topic,
/// published only by NestJS (ChatService#publishModeration).
#[derive(Debug, Clone, Deserialize)]
pub struct ModerationEvent {
    #[serde(rename = "type")]
    pub kind: ModerationEventKind,
    #[serde(rename = "channelId")]
    pub channel_id: Uuid,
    #[serde(rename = "userId")]
    pub user_id: Uuid,
    #[serde(rename = "mutedUntil")]
    pub muted_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationEventKind {
    Ban,
    Unban,
    Mute,
    Unmute,
    Promote,
    Demote,
}
