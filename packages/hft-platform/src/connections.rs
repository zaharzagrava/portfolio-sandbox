use std::sync::Arc;

use dashmap::{DashMap, DashSet};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::protocol::ServerEvent;

/// Sent to a connection's actor loop from outside itself - either a
/// plain event to relay to the browser, or an instruction to drop a
/// channel subscription immediately (used when the moderation listener
/// sees a ban land for a user who is currently subscribed).
#[derive(Debug, Clone)]
pub enum OutboundSignal {
    Event(ServerEvent),
    ForceUnsubscribe(Uuid),
}

/// Registry from user -> their live connections (a user may have several
/// tabs/devices open at once), so the moderation listener can push directly
/// to whoever needs to know about a ban/mute without waiting for them to
/// poll or reconnect.
#[derive(Clone)]
pub struct Connections {
    by_conn: Arc<DashMap<Uuid, mpsc::UnboundedSender<OutboundSignal>>>,
    by_user: Arc<DashMap<Uuid, DashSet<Uuid>>>,
}

impl Connections {
    pub fn new() -> Self {
        Self {
            by_conn: Arc::new(DashMap::new()),
            by_user: Arc::new(DashMap::new()),
        }
    }

    pub fn register(
        &self,
        conn_id: Uuid,
        user_id: Uuid,
        tx: mpsc::UnboundedSender<OutboundSignal>,
    ) {
        self.by_conn.insert(conn_id, tx);
        self.by_user
            .entry(user_id)
            .or_insert_with(DashSet::new)
            .insert(conn_id);
    }

    pub fn deregister(&self, conn_id: Uuid, user_id: Uuid) {
        self.by_conn.remove(&conn_id);

        if let Some(set) = self.by_user.get(&user_id) {
            set.remove(&conn_id);
            let now_empty = set.is_empty();
            drop(set);
            if now_empty {
                self.by_user.remove(&user_id);
            }
        }
    }

    pub fn notify_user(&self, user_id: Uuid, signal: OutboundSignal) {
        let Some(set) = self.by_user.get(&user_id) else {
            return;
        };
        let conn_ids: Vec<Uuid> = set.iter().map(|r| *r).collect();
        drop(set);

        for conn_id in conn_ids {
            if let Some(tx) = self.by_conn.get(&conn_id) {
                let _ = tx.send(signal.clone());
            }
        }
    }
}
