use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use uuid::Uuid;

/// Matches the `typ` claim ChatService#mintWsTicket stamps on the
/// short-lived ticket (packages/backend/libs/common/src/chat/chat.constants.ts,
/// CHAT_WS_TICKET_TYPE) so a normal long-lived access JWT can never be used
/// to open a WebSocket, and vice versa.
const WS_TICKET_TYPE: &str = "ws";

#[derive(Debug, Deserialize)]
struct TicketClaims {
    sub: Uuid,
    typ: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid or expired ticket")]
    InvalidTicket(#[from] jsonwebtoken::errors::Error),
    #[error("wrong token type")]
    WrongTokenType,
}

/// Verifies a chat-gateway WS ticket signed by ChatService#mintWsTicket with
/// the same JWT_SECRET the NestJS backend uses for its normal access
/// tokens - `typ` is what stops the two token kinds from being
/// interchangeable.
pub fn verify_ticket(token: &str, secret: &str) -> Result<Uuid, AuthError> {
    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<TicketClaims>(token, &DecodingKey::from_secret(secret.as_bytes()), &validation)?;

    if data.claims.typ != WS_TICKET_TYPE {
        return Err(AuthError::WrongTokenType);
    }

    Ok(data.claims.sub)
}
