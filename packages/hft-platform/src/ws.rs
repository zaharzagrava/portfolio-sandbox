use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::verify_ticket;
use crate::connections::OutboundSignal;
use crate::db;
use crate::protocol::{ChannelEnvelope, ClientOp, ServerEvent};
use crate::rate_limit::RateLimiter;
use crate::redis_bus::publish_channel_event;
use crate::state::AppState;

const MAX_MESSAGE_BODY_LEN: usize = 4000;
const SEND_RATE_LIMIT: u32 = 5;
const SEND_RATE_WINDOW: Duration = Duration::from_secs(3);
const TYPING_RATE_LIMIT: u32 = 4;
const TYPING_RATE_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    ticket: String,
}

/// One socket per client, multiplexing every channel they're subscribed to
/// (Discord-style) rather than one connection per channel - the whole point
/// of doing this in Rust instead of NestJS is keeping per-connection
/// overhead low enough to hold huge numbers of these open at once.
pub async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let user_id = match verify_ticket(&query.ticket, &state.jwt_secret) {
        Ok(id) => id,
        Err(err) => {
            warn!(%err, "ws: ticket rejected");
            return (StatusCode::UNAUTHORIZED, "invalid ticket").into_response();
        }
    };

    ws.on_upgrade(move |socket| handle_connection(socket, state, user_id))
        .into_response()
}

struct Subscription {
    role: db::MemberRole,
    stop: oneshot::Sender<()>,
}

async fn handle_connection(socket: WebSocket, state: Arc<AppState>, user_id: Uuid) {
    let conn_id = Uuid::now_v7();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<OutboundSignal>();

    state.connections.register(conn_id, user_id, outbound_tx.clone());
    info!(%conn_id, %user_id, "ws: connected");

    if send_ws_event(&mut ws_tx, &ServerEvent::Ready { user_id })
        .await
        .is_err()
    {
        state.connections.deregister(conn_id, user_id);
        return;
    }

    let mut subscriptions: HashMap<Uuid, Subscription> = HashMap::new();
    let mut send_limiter = RateLimiter::new(SEND_RATE_LIMIT, SEND_RATE_WINDOW);
    let mut typing_limiter = RateLimiter::new(TYPING_RATE_LIMIT, TYPING_RATE_WINDOW);

    'outer: loop {
        tokio::select! {
            incoming = ws_rx.next() => {
                let Some(incoming) = incoming else { break 'outer; };
                let msg = match incoming {
                    Ok(m) => m,
                    Err(err) => {
                        warn!(%conn_id, %err, "ws: read error");
                        break 'outer;
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let events = handle_client_op(
                            text.as_str(),
                            &state,
                            user_id,
                            &outbound_tx,
                            &mut subscriptions,
                            &mut send_limiter,
                            &mut typing_limiter,
                        ).await;

                        for event in &events {
                            if send_ws_event(&mut ws_tx, event).await.is_err() {
                                break 'outer;
                            }
                        }
                    }
                    Message::Close(_) => break 'outer,
                    _ => {} // binary/ping/pong - axum handles ping/pong keepalive itself
                }
            }
            signal = outbound_rx.recv() => {
                let Some(signal) = signal else { break 'outer; };
                match signal {
                    OutboundSignal::Event(event) => {
                        if send_ws_event(&mut ws_tx, &event).await.is_err() {
                            break 'outer;
                        }
                    }
                    OutboundSignal::ForceUnsubscribe(channel_id) => {
                        subscriptions.remove(&channel_id);
                        if send_ws_event(&mut ws_tx, &ServerEvent::Banned { channel_id }).await.is_err() {
                            break 'outer;
                        }
                    }
                }
            }
        }
    }

    state.connections.deregister(conn_id, user_id);
    info!(%conn_id, %user_id, "ws: disconnected");
    // `subscriptions` drops here, dropping every forwarder's oneshot sender
    // and signalling those tasks to stop.
}

async fn send_ws_event(
    ws_tx: &mut SplitSink<WebSocket, Message>,
    event: &ServerEvent,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(event).expect("ServerEvent always serializes");
    ws_tx.send(Message::Text(payload)).await
}

async fn handle_client_op(
    text: &str,
    state: &Arc<AppState>,
    user_id: Uuid,
    outbound_tx: &mpsc::UnboundedSender<OutboundSignal>,
    subscriptions: &mut HashMap<Uuid, Subscription>,
    send_limiter: &mut RateLimiter,
    typing_limiter: &mut RateLimiter,
) -> Vec<ServerEvent> {
    let op: ClientOp = match serde_json::from_str(text) {
        Ok(op) => op,
        Err(err) => {
            return vec![ServerEvent::error(
                "bad_request",
                format!("invalid frame: {err}"),
            )];
        }
    };

    match op {
        ClientOp::Ping => vec![ServerEvent::Pong],

        ClientOp::Subscribe { channel_id } => {
            handle_subscribe(state, user_id, channel_id, outbound_tx, subscriptions).await
        }

        ClientOp::Unsubscribe { channel_id } => {
            subscriptions.remove(&channel_id);
            vec![ServerEvent::Unsubscribed { channel_id }]
        }

        ClientOp::Send {
            channel_id,
            body,
            reply_to_id,
        } => handle_send(state, user_id, channel_id, body, reply_to_id, subscriptions, send_limiter).await,

        ClientOp::Typing { channel_id } => {
            handle_typing(state, user_id, channel_id, subscriptions, typing_limiter).await
        }

        ClientOp::Read {
            channel_id,
            message_id,
        } => handle_read(state, user_id, channel_id, message_id, subscriptions).await,
    }
}

/// Loads membership, preferring the cache. When `auto_join` is true (the
/// `subscribe`/`send` path) a first-time visitor is lazily added as a
/// MEMBER, mirroring ChatDtoService#ensureMember on the NestJS side.
async fn load_membership(
    state: &Arc<AppState>,
    channel_id: Uuid,
    user_id: Uuid,
    auto_join: bool,
) -> Result<db::Membership, ServerEvent> {
    if let Some(cached) = state.member_cache.get(channel_id, user_id) {
        return Ok(cached);
    }

    let fetched = if auto_join {
        db::ensure_membership(&state.pg, channel_id, user_id).await
    } else {
        match db::fetch_membership(&state.pg, channel_id, user_id).await {
            Ok(Some(m)) => Ok(m),
            Ok(None) => {
                return Err(ServerEvent::error(
                    "not_subscribed",
                    "subscribe to this channel first",
                ));
            }
            Err(err) => Err(err),
        }
    };

    match fetched {
        Ok(membership) => {
            state.member_cache.put(channel_id, user_id, membership.clone());
            Ok(membership)
        }
        Err(err) => {
            warn!(%err, "ws: membership lookup failed");
            Err(ServerEvent::error("internal", "failed to load membership"))
        }
    }
}

async fn handle_subscribe(
    state: &Arc<AppState>,
    user_id: Uuid,
    channel_id: Uuid,
    outbound_tx: &mpsc::UnboundedSender<OutboundSignal>,
    subscriptions: &mut HashMap<Uuid, Subscription>,
) -> Vec<ServerEvent> {
    if let Some(existing) = subscriptions.get(&channel_id) {
        return vec![ServerEvent::Subscribed {
            channel_id,
            role: existing.role.as_str().to_string(),
        }];
    }

    let channel = match db::fetch_channel(&state.pg, channel_id).await {
        Ok(Some(c)) => c,
        Ok(None) => return vec![ServerEvent::error("not_found", "channel does not exist")],
        Err(err) => {
            warn!(%err, "ws: fetch_channel failed");
            return vec![ServerEvent::error("internal", "failed to load channel")];
        }
    };

    if channel.is_archived {
        return vec![ServerEvent::error("archived", "this channel is archived")];
    }

    let membership = match load_membership(state, channel_id, user_id, true).await {
        Ok(m) => m,
        Err(event) => return vec![event],
    };

    if membership.status == db::MemberStatus::Banned {
        return vec![ServerEvent::error(
            "banned",
            "you are banned from this channel",
        )];
    }

    let mut rx = state.hub.subscribe(channel_id);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let forward_tx = outbound_tx.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                msg = rx.recv() => {
                    match msg {
                        Ok(envelope) => {
                            let event: ServerEvent = (*envelope).clone().into();
                            if forward_tx.send(OutboundSignal::Event(event)).is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            // Fell behind the local fan-out buffer - skip ahead
                            // rather than dying, matching "at most once,
                            // best-effort realtime delivery" semantics.
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    subscriptions.insert(
        channel_id,
        Subscription {
            role: membership.role,
            stop: stop_tx,
        },
    );

    vec![ServerEvent::Subscribed {
        channel_id,
        role: membership.role.as_str().to_string(),
    }]
}

async fn handle_send(
    state: &Arc<AppState>,
    user_id: Uuid,
    channel_id: Uuid,
    body: String,
    reply_to_id: Option<Uuid>,
    subscriptions: &HashMap<Uuid, Subscription>,
    limiter: &mut RateLimiter,
) -> Vec<ServerEvent> {
    if !subscriptions.contains_key(&channel_id) {
        return vec![ServerEvent::error(
            "not_subscribed",
            "subscribe to this channel first",
        )];
    }

    if !limiter.check() {
        return vec![ServerEvent::error(
            "rate_limited",
            "you're sending messages too fast",
        )];
    }

    let trimmed = body.trim();
    if trimmed.is_empty() {
        return vec![ServerEvent::error("bad_request", "message body cannot be empty")];
    }
    if trimmed.chars().count() > MAX_MESSAGE_BODY_LEN {
        return vec![ServerEvent::error("bad_request", "message is too long")];
    }

    let membership = match load_membership(state, channel_id, user_id, true).await {
        Ok(m) => m,
        Err(event) => return vec![event],
    };

    if membership.status == db::MemberStatus::Banned {
        return vec![ServerEvent::error(
            "banned",
            "you are banned from this channel",
        )];
    }
    if let Some(muted_until) = membership.muted_until {
        if muted_until > chrono::Utc::now() {
            return vec![ServerEvent::Muted {
                channel_id,
                muted_until,
            }];
        }
    }

    let message = match db::insert_message(&state.pg, channel_id, user_id, trimmed, reply_to_id).await {
        Ok(m) => m,
        Err(err) => {
            warn!(%err, "ws: insert_message failed");
            return vec![ServerEvent::error("internal", "failed to send message")];
        }
    };

    let envelope = ChannelEnvelope::Message {
        channel_id,
        message: message.clone(),
    };
    let mut conn = state.redis_publish.clone();
    match publish_channel_event(&mut conn, channel_id, &envelope).await {
        // No direct ack on the happy path - the sender sees their own
        // message the same way every other subscriber does, via the Hub.
        Ok(()) => Vec::new(),
        Err(err) => {
            warn!(%err, "ws: failed to publish message to redis; echoing directly instead");
            // The message is already durable in Postgres; only realtime
            // fan-out failed, so at least give the sender their own copy.
            vec![ServerEvent::Message { channel_id, message }]
        }
    }
}

async fn handle_typing(
    state: &Arc<AppState>,
    user_id: Uuid,
    channel_id: Uuid,
    subscriptions: &HashMap<Uuid, Subscription>,
    limiter: &mut RateLimiter,
) -> Vec<ServerEvent> {
    if !subscriptions.contains_key(&channel_id) || !limiter.check() {
        return Vec::new();
    }

    let envelope = ChannelEnvelope::Typing { channel_id, user_id };
    let mut conn = state.redis_publish.clone();
    if let Err(err) = publish_channel_event(&mut conn, channel_id, &envelope).await {
        warn!(%err, "ws: failed to publish typing event");
    }

    Vec::new()
}

async fn handle_read(
    state: &Arc<AppState>,
    user_id: Uuid,
    channel_id: Uuid,
    // The wire protocol carries this for the client's own bookkeeping /
    // future use; the server currently just stamps "read up to now" rather
    // than tracking a per-message read cursor.
    _message_id: Uuid,
    subscriptions: &HashMap<Uuid, Subscription>,
) -> Vec<ServerEvent> {
    if !subscriptions.contains_key(&channel_id) {
        return Vec::new();
    }

    if let Err(err) = db::update_last_read(&state.pg, channel_id, user_id).await {
        warn!(%err, "ws: update_last_read failed");
    }

    Vec::new()
}
