use std::env;

/// Mirrors the subset of packages/backend/.env this service actually needs.
/// Reuses the same DB_*/REDIS_URL/JWT_SECRET values as the NestJS backend -
/// they must point at the same Postgres/Redis/secret for the two runtimes to
/// agree on auth and data.
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        let host = env::var("DB_HOST").expect("DB_HOST is required");
        let port = env::var("DB_PORT").expect("DB_PORT is required");
        let user = env::var("DB_USERNAME").expect("DB_USERNAME is required");
        let password = env::var("DB_PASSWORD").expect("DB_PASSWORD is required");
        let name = env::var("DB_NAME").expect("DB_NAME is required");

        let database_url = format!(
            "postgres://{user}:{password}@{host}:{port}/{name}",
            user = urlencode(&user),
            password = urlencode(&password),
        );

        let redis_url = env::var("REDIS_URL").expect("REDIS_URL is required");
        let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET is required");
        let port = env::var("CHAT_GATEWAY_PORT")
            .unwrap_or_else(|_| "8090".to_string())
            .parse::<u16>()
            .expect("CHAT_GATEWAY_PORT must be a valid port number");

        Self {
            database_url,
            redis_url,
            jwt_secret,
            port,
        }
    }
}

/// Minimal percent-encoding for the username/password segment of a Postgres
/// connection URL - avoids pulling in a whole URL crate for two fields.
fn urlencode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
