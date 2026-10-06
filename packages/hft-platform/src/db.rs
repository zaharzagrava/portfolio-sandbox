use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::protocol::MessageDto;

/// Table/column names below are quoted to match exactly what Sequelize
/// generated in packages/backend/migrations/20260925090000-create-chat-tables.js
/// (Postgres folds unquoted identifiers to lowercase, which would miss the
/// camelCase tables/columns Sequelize actually created).

#[derive(Debug, sqlx::FromRow)]
pub struct ChannelRow {
    pub id: Uuid,
    pub is_archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberRole {
    Owner,
    Moderator,
    Member,
}

impl MemberRole {
    fn from_db(s: &str) -> Self {
        match s {
            "OWNER" => MemberRole::Owner,
            "MODERATOR" => MemberRole::Moderator,
            _ => MemberRole::Member,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MemberRole::Owner => "OWNER",
            MemberRole::Moderator => "MODERATOR",
            MemberRole::Member => "MEMBER",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberStatus {
    Active,
    Banned,
}

impl MemberStatus {
    fn from_db(s: &str) -> Self {
        match s {
            "BANNED" => MemberStatus::Banned,
            _ => MemberStatus::Active,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Membership {
    pub role: MemberRole,
    pub status: MemberStatus,
    pub muted_until: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    role: String,
    status: String,
    muted_until: Option<DateTime<Utc>>,
}

impl From<MemberRow> for Membership {
    fn from(row: MemberRow) -> Self {
        Membership {
            role: MemberRole::from_db(&row.role),
            status: MemberStatus::from_db(&row.status),
            muted_until: row.muted_until,
        }
    }
}

pub async fn fetch_channel(pool: &PgPool, channel_id: Uuid) -> sqlx::Result<Option<ChannelRow>> {
    sqlx::query_as::<_, ChannelRow>(
        r#"SELECT "id", "isArchived" AS is_archived FROM "ChatChannel" WHERE "id" = $1"#,
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await
}

pub async fn fetch_membership(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<Option<Membership>> {
    let row = sqlx::query_as::<_, MemberRow>(
        r#"
        SELECT "role"::text AS role, "status"::text AS status, "mutedUntil" AS muted_until
        FROM "ChatChannelMember"
        WHERE "channelId" = $1 AND "userId" = $2
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Membership::from))
}

/// Lazily creates a MEMBER row on first contact with a channel, matching
/// ChatDtoService#ensureMember on the NestJS side. Never touches role/status
/// of an existing row (a banned user stays banned), only bumps updatedAt so
/// RETURNING always yields a row via the same statement.
pub async fn ensure_membership(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<Membership> {
    let row = sqlx::query_as::<_, MemberRow>(
        r#"
        INSERT INTO "ChatChannelMember"
            ("id", "channelId", "userId", "role", "status", "createdAt", "updatedAt")
        VALUES
            ($1, $2, $3, 'MEMBER', 'ACTIVE', now(), now())
        ON CONFLICT ("channelId", "userId")
        DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt"
        RETURNING "role"::text AS role, "status"::text AS status, "mutedUntil" AS muted_until
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(Membership::from(row))
}

pub async fn insert_message(
    pool: &PgPool,
    channel_id: Uuid,
    author_id: Uuid,
    body: &str,
    reply_to_id: Option<Uuid>,
) -> sqlx::Result<MessageDto> {
    sqlx::query_as::<_, MessageDto>(
        r#"
        INSERT INTO "ChatMessage"
            ("id", "channelId", "authorId", "body", "replyToId", "createdAt")
        VALUES
            ($1, $2, $3, $4, $5, now())
        RETURNING
            "id",
            "channelId" AS channel_id,
            "authorId" AS author_id,
            "body",
            "replyToId" AS reply_to_id,
            "createdAt" AS created_at
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(channel_id)
    .bind(author_id)
    .bind(body)
    .bind(reply_to_id)
    .fetch_one(pool)
    .await
}

pub async fn update_last_read(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE "ChatChannelMember" SET "lastReadAt" = now() WHERE "channelId" = $1 AND "userId" = $2"#,
    )
    .bind(channel_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(())
}
