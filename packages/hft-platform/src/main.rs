mod auth;
mod cache;
mod config;
mod connections;
mod db;
mod hub;
mod protocol;
mod rate_limit;
mod redis_bus;
mod state;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env();

    let pg = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to postgres");

    let redis_client = redis::Client::open(config.redis_url.clone()).expect("invalid REDIS_URL");
    let redis_publish = redis_client
        .get_multiplexed_async_connection()
        .await
        .expect("failed to connect to redis");

    let state = Arc::new(AppState::new(
        pg,
        redis_client.clone(),
        redis_publish,
        config.jwt_secret.clone(),
    ));

    // Global, process-lifetime listener for bans/mutes/promotions - see
    // redis_bus::spawn_moderation_listener for why every instance needs it.
    redis_bus::spawn_moderation_listener(redis_client, state.clone());

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/health", get(health))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!(%addr, "chat-gateway listening");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind chat-gateway port");

    axum::serve(listener, app)
        .await
        .expect("chat-gateway server error");
}

async fn health() -> &'static str {
    "ok"
}
