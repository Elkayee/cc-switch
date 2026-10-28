//! Optional bearer-token authentication for browser (server) mode.
//!
//! Off by default: the server binds to loopback, and the common case is a
//! single-user machine where an extra secret to copy around buys little. Pass
//! `--token <TOKEN>` to turn the check on, and every `/api/*` route then
//! requires it.
//!
//! Worth knowing when deciding: loopback is not by itself a security boundary.
//! Without a token, any local process — and, via DNS rebinding, a page you have
//! open from an unrelated origin — can drive the whole config API, which
//! includes reading provider API keys and writing MCP entries that the CLIs
//! later execute. `--token` is what closes that, so it is the right choice on a
//! shared machine or any non-loopback bind.

use std::sync::Arc;

use axum::{
    extract::{Query, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

/// The token the user supplied via `--token`.
///
/// User-chosen rather than generated, which is what makes it stable across
/// restarts: a URL you bookmarked keeps working, because the same value comes
/// back on the next launch.
#[derive(Clone)]
pub struct AuthToken(Arc<String>);

impl AuthToken {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(Arc::new(raw.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Constant-time comparison, so a caller cannot recover the token
    /// byte-by-byte by measuring how long a rejection takes.
    fn matches(&self, candidate: &str) -> bool {
        let expected = self.0.as_bytes();
        let actual = candidate.as_bytes();
        if expected.len() != actual.len() {
            return false;
        }
        let mut diff = 0u8;
        for (a, b) in expected.iter().zip(actual.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

#[derive(Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

/// Rejects any `/api/*` request that does not carry the current token.
///
/// Accepts either `Authorization: Bearer <token>` (what the webshim's
/// `invoke()` sends) or `?token=<token>` (needed for `EventSource`, which the
/// browser gives us no way to attach custom headers to).
pub async fn require_token(
    State(token): State<AuthToken>,
    Query(query): Query<TokenQuery>,
    request: Request,
    next: Next,
) -> Response {
    let from_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned);

    let presented = from_header.or(query.token);

    match presented {
        Some(value) if token.matches(&value) => next.run(request).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"missing or invalid token"}"#,
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::AuthToken;

    #[test]
    fn keeps_the_value_it_was_given() {
        assert_eq!(AuthToken::new("s3cret").as_str(), "s3cret");
    }

    #[test]
    fn matches_only_the_exact_token() {
        let token = AuthToken::new("s3cret-value");

        assert!(token.matches("s3cret-value"));
        assert!(!token.matches(""));
        assert!(!token.matches("s3cret-valu"));
        assert!(!token.matches("s3cret-valuex"));
        assert!(!token.matches("S3CRET-VALUE"));
    }

    /// Multi-byte input must not panic the comparison, which slices bytes.
    #[test]
    fn handles_non_ascii_candidates() {
        let token = AuthToken::new("mật-khẩu");
        assert!(token.matches("mật-khẩu"));
        assert!(!token.matches("mat-khau"));
    }
}
