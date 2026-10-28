//! Token for clients that talk to the upstream directly (fork).
//!
//! A managed OAuth provider (xAI, ChatGPT/Codex, GitHub Copilot) has no static key:
//! the proxy attaches the token per request. This module hands the same token to a
//! client that wants to call the upstream itself, over
//! `GET /auth/token/{app}/{provider_id}` and through the `get_provider_direct_token`
//! command (the popup).
//!
//! The HTTP route answers `text/plain`: the body is the bare token (curl-friendly,
//! no JSON to parse). Metadata travels in headers: `X-Token-Expires-At` (unix ms),
//! `X-Token-Expires-In` (s), `X-Token-Refreshed`, `X-Token-Provider`, `Retry-After`
//! (s, report ignored), `X-Upstream-Endpoint` (full URL to call) and one
//! `X-Upstream-<Header>` per header the upstream also needs (e.g.
//! `X-Upstream-ChatGPT-Account-Id`, the Copilot editor identity). Errors are a
//! plain-text message with the matching status code and `X-Error-Code`.
//!
//! The route is called often, so it never refreshes on its own schedule
//! (`lease`, shared by all three providers):
//! * no report: the cached token. It is renewed when near expiry, or early when
//!   under an hour is left of a token issued with at least an hour (a token with a
//!   shorter or unknown life is left alone);
//! * `X-Invalid-Token: <token>`: the client got a 401 for that token. It is
//!   evicted only if it is still the cached one, so a burst of identical reports
//!   causes one refresh, and evictions are rate limited per account.
//!
//! Evicting only drops the cached access token; the refresh itself runs through the
//! provider manager's normal single-flight path, which is also what writes a
//! rotated refresh token back (Codex shares it with the Codex CLI's `auth.json`).

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tauri::Manager;

use super::providers::codex_oauth_auth::{CodexOAuthError, CodexOAuthManager};
use super::providers::copilot_auth::{CopilotAuthError, CopilotAuthManager};
use super::providers::xai_oauth_auth::{XaiOAuthError, XaiOAuthManager};
use super::server::ProxyState;
use crate::commands::{CodexOAuthState, CopilotAuthState, XaiOAuthState};
use crate::provider::{AuthBindingSource, Provider};

/// Header a client uses to report the token that was rejected with a 401.
pub const INVALID_TOKEN_HEADER: &str = "x-invalid-token";

/// Renew a token with less than this left (see `should_refresh_early`).
const EARLY_REFRESH_WINDOW_MS: i64 = 3_600_000;
/// Minimum gap between evictions per account. A client that keeps getting 401 for a
/// reason other than the token would otherwise rotate the refresh token on every call.
const FORCED_REFRESH_COOLDOWN_MS: i64 = 30_000;
/// After a failed refresh, answer callers from the failure instead of letting each of
/// them hit the token endpoint again.
const REFRESH_FAILURE_BACKOFF_MS: i64 = 5_000;
/// A token with less than this left is not worth handing out as a fallback.
const FALLBACK_MIN_REMAINING_MS: i64 = 60_000;

/// TCP peer of the request, inserted by the accept loop.
#[derive(Debug, Clone, Copy)]
pub struct PeerAddr(pub SocketAddr);

/// A header the upstream needs besides `Authorization: Bearer <token>`.
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenGrant {
    pub access_token: String,
    pub token_type: &'static str,
    /// `xai_oauth` | `codex_oauth` | `github_copilot`.
    pub auth_provider: &'static str,
    /// Full URL a direct client POSTs to.
    pub endpoint: String,
    /// Headers the upstream needs besides the bearer token.
    pub headers: Vec<UpstreamHeader>,
    /// Unix ms; the client should call again shortly before this.
    pub expires_at: Option<i64>,
    pub expires_in: Option<i64>,
    /// The cached token was replaced: reported rejected, or renewed early.
    pub refreshed: bool,
    /// The report was ignored (cooldown): same token, ask again after this many seconds.
    pub retry_after: Option<u64>,
    pub account_id: String,
}

#[derive(Debug)]
pub enum TokenError {
    NotManagedOAuth,
    NoAccount,
    ReauthRequired,
    /// The provider's account cannot be served safely (e.g. GitHub Enterprise Server).
    Unsupported(String),
    Upstream(String),
}

impl TokenError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::NotManagedOAuth => (StatusCode::BAD_REQUEST, "not_managed_oauth"),
            Self::NoAccount => (StatusCode::CONFLICT, "no_account"),
            Self::ReauthRequired => (StatusCode::CONFLICT, "reauth_required"),
            Self::Unsupported(_) => (StatusCode::BAD_REQUEST, "unsupported_account"),
            Self::Upstream(_) => (StatusCode::BAD_GATEWAY, "refresh_failed"),
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::NotManagedOAuth => {
                "provider does not use a managed OAuth account (xAI, ChatGPT or GitHub Copilot)"
                    .into()
            }
            Self::NoAccount => "no OAuth account is signed in for this provider".into(),
            Self::ReauthRequired => "the OAuth account must sign in again".into(),
            Self::Unsupported(message) | Self::Upstream(message) => message.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Lease policy (shared by every provider)
// ---------------------------------------------------------------------------

/// What a provider manager has cached for an account.
#[derive(Debug, Clone)]
pub struct TokenView {
    pub token: String,
    pub expires_at_ms: Option<i64>,
    /// Total life the token was issued with (ms); 0 when unknown.
    pub lifetime_ms: i64,
}

/// The three managers behind one small seam, so the policy is written once.
pub trait TokenSource: Sync {
    /// The cached token, without refreshing.
    fn peek(&self, account: &str) -> impl Future<Output = Option<TokenView>> + Send;
    /// Drop the cached token so the next `fetch` refreshes.
    fn evict(&self, account: &str) -> impl Future<Output = ()> + Send;
    /// A valid token, refreshing through the manager's single-flight path when needed.
    fn fetch(&self, account: &str) -> impl Future<Output = Result<String, TokenError>> + Send;
}

/// Renew ahead of time when under `EARLY_REFRESH_WINDOW_MS` is left, so a direct
/// client is handed a token with room to work. A token issued with a short life
/// (under the window) is always "almost expired", so it is left to the normal expiry
/// path instead of being renewed on every call. Capped at half the lifetime so a
/// token just over the window is not renewed again right after it was minted.
pub(crate) fn should_refresh_early(view: &TokenView, now_ms: i64) -> bool {
    let Some(expires_at) = view.expires_at_ms else {
        return false;
    };
    if view.lifetime_ms < EARLY_REFRESH_WINDOW_MS {
        return false;
    }
    expires_at - now_ms < EARLY_REFRESH_WINDOW_MS.min(view.lifetime_ms / 2)
}

#[derive(Default)]
struct Slot {
    /// When an eviction last happened (ms).
    forced_at: Option<i64>,
    /// When and why the last refresh failed.
    failure: Option<(i64, String)>,
    /// A still-good token evicted for an early renewal, served if the renewal fails.
    fallback: Option<TokenView>,
}

impl Slot {
    fn cooldown_wait_ms(&self, now_ms: i64) -> Option<i64> {
        let wait = FORCED_REFRESH_COOLDOWN_MS - (now_ms - self.forced_at?);
        (wait > 0).then_some(wait)
    }

    fn recent_failure(&self, now_ms: i64) -> Option<String> {
        let (at, message) = self.failure.as_ref()?;
        (now_ms - at < REFRESH_FAILURE_BACKOFF_MS).then(|| message.clone())
    }

    fn usable_fallback(&self, now_ms: i64) -> Option<TokenView> {
        self.fallback.clone().filter(|view| {
            view.expires_at_ms
                .is_some_and(|at| at - now_ms > FALLBACK_MIN_REMAINING_MS)
        })
    }
}

/// Per-account policy state. One mutex per account serialises the check-and-evict
/// (no network inside), so of many callers that see the same stale token exactly one
/// evicts it and the rest wait for the refresh.
#[derive(Default)]
pub struct LeaseGate {
    slots: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Slot>>>>,
}

impl LeaseGate {
    fn slot(&self, key: &str) -> Arc<tokio::sync::Mutex<Slot>> {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.entry(key.to_string()).or_default().clone()
    }
}

static GATE: LazyLock<LeaseGate> = LazyLock::new(LeaseGate::default);

#[derive(Debug, Clone)]
pub struct Lease {
    pub token: String,
    pub expires_at_ms: Option<i64>,
    pub refreshed: bool,
    pub retry_after_secs: Option<u64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Lease a token for `account` from `source` under the shared policy.
pub async fn lease<S: TokenSource>(
    gate: &LeaseGate,
    key: &str,
    source: &S,
    account: &str,
    rejected: Option<&str>,
) -> Result<Lease, TokenError> {
    let rejected = rejected.map(str::trim).filter(|token| !token.is_empty());
    let slot = gate.slot(key);
    let mut refreshed = false;
    let mut retry_after_secs = None;

    {
        let mut state = slot.lock().await;
        let now = now_ms();
        match source.peek(account).await {
            Some(view) => {
                let reported = rejected == Some(view.token.as_str());
                let early = should_refresh_early(&view, now);
                if reported || early {
                    match state.cooldown_wait_ms(now) {
                        // Keep serving the current token. Only a reported rejection
                        // is told to come back later.
                        Some(wait_ms) => {
                            if reported {
                                retry_after_secs =
                                    Some(u64::try_from((wait_ms + 999) / 1_000).unwrap_or(1));
                            }
                        }
                        None => {
                            source.evict(account).await;
                            state.forced_at = Some(now);
                            // A rejected token is useless; an early one is still good if
                            // the renewal fails.
                            state.fallback = (!reported).then_some(view);
                            refreshed = true;
                        }
                    }
                }
            }
            None => {
                if let Some(message) = state.recent_failure(now) {
                    return match state.usable_fallback(now) {
                        Some(view) => Ok(Lease {
                            token: view.token,
                            expires_at_ms: view.expires_at_ms,
                            refreshed: false,
                            retry_after_secs: None,
                        }),
                        None => Err(TokenError::Upstream(message)),
                    };
                }
            }
        }
    }

    match source.fetch(account).await {
        Ok(token) => {
            let expires_at_ms = source
                .peek(account)
                .await
                .filter(|view| view.token == token)
                .and_then(|view| view.expires_at_ms);
            let mut state = slot.lock().await;
            state.failure = None;
            state.fallback = None;
            Ok(Lease {
                token,
                expires_at_ms,
                refreshed,
                retry_after_secs,
            })
        }
        Err(error) => {
            let mut state = slot.lock().await;
            let now = now_ms();
            if let TokenError::Upstream(message) = &error {
                state.failure = Some((now, message.clone()));
            }
            match state.usable_fallback(now) {
                Some(view) => Ok(Lease {
                    token: view.token,
                    expires_at_ms: view.expires_at_ms,
                    refreshed: false,
                    retry_after_secs: None,
                }),
                None => Err(error),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Xai,
    Codex,
    Copilot,
}

impl Kind {
    fn auth_provider(self) -> &'static str {
        match self {
            Self::Xai => "xai_oauth",
            Self::Codex => "codex_oauth",
            Self::Copilot => "github_copilot",
        }
    }

    /// Same rule the forwarder uses: the provider type, else its managed-account binding.
    fn of(provider: &Provider) -> Option<Self> {
        let meta = provider.meta.as_ref()?;
        let name = meta.provider_type.as_deref().or_else(|| {
            meta.auth_binding
                .as_ref()
                .filter(|binding| binding.source == AuthBindingSource::ManagedAccount)
                .and_then(|binding| binding.auth_provider.as_deref())
        })?;
        match name {
            "xai_oauth" => Some(Self::Xai),
            "codex_oauth" => Some(Self::Codex),
            "github_copilot" => Some(Self::Copilot),
            _ => None,
        }
    }
}

pub(crate) struct XaiSource<'a>(pub(crate) &'a XaiOAuthManager);
struct CodexSource<'a>(&'a CodexOAuthManager);
struct CopilotSource<'a>(&'a CopilotAuthManager);

impl TokenSource for XaiSource<'_> {
    async fn peek(&self, account: &str) -> Option<TokenView> {
        self.0.cached_token_view(account).await
    }
    async fn evict(&self, account: &str) {
        self.0.evict_cached_token(account).await
    }
    async fn fetch(&self, account: &str) -> Result<String, TokenError> {
        self.0
            .get_valid_token_for_account(account)
            .await
            .map_err(|error| match error {
                XaiOAuthError::ReauthRequired(_) => TokenError::ReauthRequired,
                XaiOAuthError::AccountNotFound(_) => TokenError::NoAccount,
                other => TokenError::Upstream(other.to_string()),
            })
    }
}

impl TokenSource for CodexSource<'_> {
    async fn peek(&self, account: &str) -> Option<TokenView> {
        self.0.cached_token_view(account).await
    }
    async fn evict(&self, account: &str) {
        self.0.evict_cached_token(account).await
    }
    async fn fetch(&self, account: &str) -> Result<String, TokenError> {
        self.0
            .get_valid_token_for_account(account)
            .await
            .map_err(|error| match error {
                CodexOAuthError::AccountNotFound(_) => TokenError::NoAccount,
                CodexOAuthError::RefreshTokenInvalid => TokenError::ReauthRequired,
                other => TokenError::Upstream(other.to_string()),
            })
    }
}

impl TokenSource for CopilotSource<'_> {
    async fn peek(&self, account: &str) -> Option<TokenView> {
        self.0.cached_token_view(account).await
    }
    async fn evict(&self, account: &str) {
        self.0.evict_cached_token(account).await
    }
    async fn fetch(&self, account: &str) -> Result<String, TokenError> {
        self.0
            .get_valid_token_for_account(account)
            .await
            .map_err(|error| match error {
                CopilotAuthError::AccountNotFound(_) => TokenError::NoAccount,
                CopilotAuthError::GitHubTokenInvalid => TokenError::ReauthRequired,
                other => TokenError::Upstream(other.to_string()),
            })
    }
}

/// The three provider managers, however the caller got hold of them.
pub struct Managers<'a> {
    pub xai: &'a XaiOAuthManager,
    pub codex: &'a CodexOAuthManager,
    pub copilot: &'a CopilotAuthManager,
}

const XAI_ENDPOINT: &str = "https://api.x.ai/v1/responses";
const CODEX_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";

/// Copilot identity headers a bare token lacks. `authorization` and the per-request
/// ids are left out: the client adds the bearer, and ids must be unique per request.
fn copilot_identity_headers() -> Vec<UpstreamHeader> {
    let Ok(headers) = super::providers::copilot_auth::build_copilot_request_headers("x") else {
        return Vec::new();
    };
    headers
        .into_iter()
        .filter(|(name, _)| {
            !matches!(
                name.as_str(),
                "authorization" | "x-request-id" | "x-agent-task-id"
            )
        })
        .filter_map(|(name, value)| {
            Some(UpstreamHeader {
                name: name.as_str().to_string(),
                value: value.to_str().ok()?.to_string(),
            })
        })
        .collect()
}

/// Resolve the account a provider uses and lease its token.
pub async fn grant_provider_token(
    managers: Managers<'_>,
    provider: &Provider,
    rejected: Option<&str>,
) -> Result<TokenGrant, TokenError> {
    let kind = Kind::of(provider).ok_or(TokenError::NotManagedOAuth)?;
    let meta = provider.meta.as_ref();
    let bound = meta.and_then(|meta| meta.managed_account_id_for(kind.auth_provider()));

    let (account_id, lease, endpoint, headers) = match kind {
        Kind::Xai => {
            let account = managers
                .xai
                .account_id_for_provider(bound)
                .await
                .ok_or(TokenError::NoAccount)?;
            let lease = lease(
                &GATE,
                &format!("xai:{account}"),
                &XaiSource(managers.xai),
                &account,
                rejected,
            )
            .await?;
            (account, lease, XAI_ENDPOINT.to_string(), Vec::new())
        }
        Kind::Codex => {
            let account = managers
                .codex
                .account_id_for_provider(bound)
                .await
                .ok_or(TokenError::NoAccount)?;
            let workspace = managers
                .codex
                .chatgpt_account_id_for_account(&account)
                .await
                .map_err(|_| TokenError::ReauthRequired)?;
            let lease = lease(
                &GATE,
                &format!("codex:{account}"),
                &CodexSource(managers.codex),
                &account,
                rejected,
            )
            .await?;
            let headers = vec![UpstreamHeader {
                name: "ChatGPT-Account-Id".into(),
                value: workspace,
            }];
            (account, lease, CODEX_ENDPOINT.to_string(), headers)
        }
        Kind::Copilot => {
            let account = managers
                .copilot
                .account_id_for_provider(bound)
                .await
                .ok_or(TokenError::NoAccount)?;
            if managers.copilot.is_ghes_account(&account).await {
                return Err(TokenError::Unsupported(
                    "GitHub Enterprise Server accounts use the long-lived GitHub token, which is never handed out".into(),
                ));
            }
            let lease = lease(
                &GATE,
                &format!("copilot:{account}"),
                &CopilotSource(managers.copilot),
                &account,
                rejected,
            )
            .await?;
            let base = managers.copilot.get_api_endpoint(&account).await;
            (
                account,
                lease,
                format!("{}/chat/completions", base.trim_end_matches('/')),
                copilot_identity_headers(),
            )
        }
    };

    let now = now_ms();
    Ok(TokenGrant {
        access_token: lease.token,
        token_type: "Bearer",
        auth_provider: kind.auth_provider(),
        endpoint,
        headers,
        expires_at: lease.expires_at_ms,
        expires_in: lease.expires_at_ms.map(|at| ((at - now) / 1_000).max(0)),
        refreshed: lease.refreshed,
        retry_after: lease.retry_after_secs,
        account_id,
    })
}

fn is_loopback_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        // `[::1]:15721` / `127.0.0.1:15721`; a bare `[::1]` has no port.
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    )
}

/// The token must never reach another machine or a web page. Browsers always
/// send `Origin` cross-origin; a DNS-rebinding page arrives with a foreign
/// `Host`; a LAN client has a non-loopback peer. Missing peer info fails closed.
fn is_local_caller(peer: Option<PeerAddr>, headers: &HeaderMap) -> bool {
    let peer_ok = peer.is_some_and(|peer| peer.0.ip().to_canonical().is_loopback());
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_loopback_host);
    peer_ok && host_ok && !headers.contains_key(header::ORIGIN)
}

fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

const TEXT_PLAIN: &str = "text/plain; charset=utf-8";

fn text_response(status: StatusCode, body: String) -> Response {
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(TEXT_PLAIN));
    no_store(response)
}

/// Plain-text error; `code` is also sent as `X-Error-Code` for scripts.
fn error_response(status: StatusCode, code: &'static str, message: &str) -> Response {
    let mut response = text_response(status, format!("{message}\n"));
    response
        .headers_mut()
        .insert("x-error-code", HeaderValue::from_static(code));
    response
}

/// The token as the whole body, no trailing newline (so `$(curl ...)` and
/// `Authorization: Bearer $(...)` work as is); metadata goes in headers.
fn token_response(grant: TokenGrant) -> Response {
    let mut response = text_response(StatusCode::OK, grant.access_token);
    let headers = response.headers_mut();
    let mut put = |name: &str, value: String| {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    };
    if let Some(at) = grant.expires_at {
        put("x-token-expires-at", at.to_string());
    }
    if let Some(secs) = grant.expires_in {
        put("x-token-expires-in", secs.to_string());
    }
    put("x-token-refreshed", grant.refreshed.to_string());
    put("x-token-account", grant.account_id);
    put("x-token-provider", grant.auth_provider.to_string());
    put("x-upstream-endpoint", grant.endpoint);
    for upstream in grant.headers {
        put(&format!("x-upstream-{}", upstream.name), upstream.value);
    }
    if let Some(secs) = grant.retry_after {
        put("retry-after", secs.to_string());
    }
    response
}

/// `GET /auth/token/{app}/{provider_id}`
pub async fn handle_direct_token(
    State(state): State<ProxyState>,
    Path((app, provider_id)): Path<(String, String)>,
    peer: Option<axum::Extension<PeerAddr>>,
    headers: HeaderMap,
) -> Response {
    if !is_local_caller(peer.map(|ext| ext.0), &headers) {
        return error_response(
            StatusCode::FORBIDDEN,
            "local_only",
            "the token endpoint only answers local, non-browser callers",
        );
    }
    let provider = match state.db.get_provider_by_id(&provider_id, &app) {
        Ok(Some(provider)) => provider,
        Ok(None) => {
            return error_response(
                StatusCode::NOT_FOUND,
                "provider_not_found",
                "unknown provider",
            )
        }
        Err(error) => {
            log::warn!("[DirectToken] provider lookup failed: {error}");
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "db_error",
                "lookup failed",
            );
        }
    };
    let Some(app_handle) = state.app_handle.as_ref() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "OAuth accounts are unavailable in this runtime",
        );
    };
    let xai = app_handle.state::<XaiOAuthState>();
    let codex = app_handle.state::<CodexOAuthState>();
    let copilot = app_handle.state::<CopilotAuthState>();
    let xai = xai.0.read().await;
    let copilot = copilot.0.read().await;
    let rejected = headers
        .get(INVALID_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());

    let managers = Managers {
        xai: &xai,
        codex: &codex.0,
        copilot: &copilot,
    };
    match grant_provider_token(managers, &provider, rejected).await {
        Ok(grant) => {
            // Flags only: the token itself never reaches the log.
            log::debug!(
                "[DirectToken] provider={provider_id} kind={} account={} refreshed={} retry_after={:?}",
                grant.auth_provider,
                grant.account_id,
                grant.refreshed,
                grant.retry_after
            );
            token_response(grant)
        }
        Err(error) => {
            let (status, code) = error.status_and_code();
            error_response(status, code, &error.message())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        if let Some(host) = host {
            map.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        if let Some(origin) = origin {
            map.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        map
    }

    fn peer(addr: &str) -> Option<PeerAddr> {
        Some(PeerAddr(addr.parse().unwrap()))
    }

    #[test]
    fn token_route_answers_plain_text_with_metadata_in_headers() {
        let response = token_response(TokenGrant {
            access_token: "tok-123".into(),
            token_type: "Bearer",
            auth_provider: "codex_oauth",
            endpoint: "https://example.test/responses".into(),
            headers: vec![UpstreamHeader {
                name: "ChatGPT-Account-Id".into(),
                value: "ws-1".into(),
            }],
            expires_at: Some(1_700_000_000_000),
            expires_in: Some(3600),
            refreshed: false,
            retry_after: Some(12),
            account_id: "acc".into(),
        });
        assert_eq!(response.status(), StatusCode::OK);
        let h = response.headers();
        assert_eq!(h[header::CONTENT_TYPE], TEXT_PLAIN);
        assert_eq!(h["x-token-expires-at"], "1700000000000");
        assert_eq!(h["x-token-refreshed"], "false");
        assert_eq!(h["retry-after"], "12");
        assert_eq!(h["x-upstream-chatgpt-account-id"], "ws-1");
        assert_eq!(h["x-upstream-endpoint"], "https://example.test/responses");
        assert_eq!(h["x-token-provider"], "codex_oauth");
        assert_eq!(h[header::CACHE_CONTROL], "no-store, max-age=0");

        let err = error_response(StatusCode::CONFLICT, "no_account", "no account");
        assert_eq!(err.headers()["x-error-code"], "no_account");
        assert_eq!(err.headers()[header::CONTENT_TYPE], TEXT_PLAIN);
    }

    #[test]
    fn local_curl_is_allowed() {
        assert!(is_local_caller(
            peer("127.0.0.1:5000"),
            &headers(Some("127.0.0.1:15721"), None)
        ));
        assert!(is_local_caller(
            peer("[::1]:5000"),
            &headers(Some("localhost:15721"), None)
        ));
        assert!(is_local_caller(
            peer("[::ffff:127.0.0.1]:5000"),
            &headers(Some("[::1]:15721"), None)
        ));
    }

    #[test]
    fn remote_browser_and_rebinding_callers_are_refused() {
        // LAN peer
        assert!(!is_local_caller(
            peer("192.168.1.9:5000"),
            &headers(Some("127.0.0.1:15721"), None)
        ));
        // DNS rebinding: loopback peer, foreign Host
        assert!(!is_local_caller(
            peer("127.0.0.1:5000"),
            &headers(Some("evil.example:15721"), None)
        ));
        // cross-origin browser fetch
        assert!(!is_local_caller(
            peer("127.0.0.1:5000"),
            &headers(Some("127.0.0.1:15721"), Some("https://evil.example"))
        ));
        // unknown peer / missing Host fail closed
        assert!(!is_local_caller(
            None,
            &headers(Some("127.0.0.1:15721"), None)
        ));
        assert!(!is_local_caller(
            peer("127.0.0.1:5000"),
            &headers(None, None)
        ));
    }
}

#[cfg(test)]
mod lease_policy_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    const HOUR: i64 = 3_600_000;

    /// In-memory stand-in for a provider manager: caches a token, refreshes on demand.
    struct Mock {
        cache: Mutex<Option<TokenView>>,
        refreshes: AtomicUsize,
        fail: AtomicBool,
        flight: tokio::sync::Mutex<()>,
        /// Life of a token the mock mints.
        new_lifetime_ms: i64,
    }

    impl Mock {
        fn new(token: &str, lifetime_ms: i64, remaining_ms: i64) -> Self {
            Self {
                cache: Mutex::new(Some(view(token, lifetime_ms, remaining_ms))),
                refreshes: AtomicUsize::new(0),
                fail: AtomicBool::new(false),
                flight: tokio::sync::Mutex::new(()),
                new_lifetime_ms: HOUR,
            }
        }

        fn refreshes(&self) -> usize {
            self.refreshes.load(Ordering::SeqCst)
        }
    }

    fn view(token: &str, lifetime_ms: i64, remaining_ms: i64) -> TokenView {
        TokenView {
            token: token.to_string(),
            expires_at_ms: Some(now_ms() + remaining_ms),
            lifetime_ms,
        }
    }

    impl TokenSource for Mock {
        async fn peek(&self, _: &str) -> Option<TokenView> {
            self.cache.lock().unwrap().clone()
        }
        async fn evict(&self, _: &str) {
            *self.cache.lock().unwrap() = None;
        }
        async fn fetch(&self, _: &str) -> Result<String, TokenError> {
            // Like the managers: a cached token with room left is served as is, and
            // refreshes are single-flight (lock plus a second look at the cache).
            let usable =
                |mock: &Mock| {
                    mock.cache.lock().unwrap().clone().filter(|c| {
                        c.expires_at_ms.unwrap_or(0) - now_ms() > FALLBACK_MIN_REMAINING_MS
                    })
                };
            if let Some(cached) = usable(self) {
                return Ok(cached.token);
            }
            let _flight = self.flight.lock().await;
            if let Some(cached) = usable(self) {
                return Ok(cached.token);
            }
            let n = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
            // Keep the call open long enough for concurrent callers to pile up.
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            if self.fail.load(Ordering::SeqCst) {
                return Err(TokenError::Upstream("token endpoint down".into()));
            }
            let fresh = view(
                &format!("token-{n}"),
                self.new_lifetime_ms,
                self.new_lifetime_ms,
            );
            *self.cache.lock().unwrap() = Some(fresh.clone());
            Ok(fresh.token)
        }
    }

    async fn call(
        gate: &LeaseGate,
        mock: &Mock,
        rejected: Option<&str>,
    ) -> Result<Lease, TokenError> {
        lease(gate, "k", mock, "acc", rejected).await
    }

    #[tokio::test]
    async fn no_report_serves_the_cached_token_without_refreshing() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", HOUR, HOUR));
        for _ in 0..20 {
            let lease = call(&gate, &mock, None).await.unwrap();
            assert_eq!(lease.token, "old");
            assert!(!lease.refreshed);
        }
        assert_eq!(mock.refreshes(), 0);
    }

    #[tokio::test]
    async fn a_report_for_a_different_token_is_ignored() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", HOUR, HOUR));
        let lease = call(&gate, &mock, Some("something-else")).await.unwrap();
        assert_eq!(lease.token, "old");
        assert!(!lease.refreshed);
        assert_eq!(mock.refreshes(), 0);
    }

    #[tokio::test]
    async fn concurrent_reports_of_the_same_stale_token_refresh_once() {
        let gate = Arc::new(LeaseGate::default());
        let mock = Arc::new(Mock::new("old", HOUR, HOUR));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let (gate, mock) = (gate.clone(), mock.clone());
                tokio::spawn(async move { call(&gate, &mock, Some("old")).await })
            })
            .collect();
        let mut refreshed = 0;
        for handle in handles {
            let lease = handle.await.unwrap().unwrap();
            assert_eq!(lease.token, "token-1");
            refreshed += usize::from(lease.refreshed);
        }
        assert_eq!(refreshed, 1, "exactly one caller evicts the stale token");
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn repeated_reports_are_rate_limited_per_account() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", HOUR, HOUR));
        let first = call(&gate, &mock, Some("old")).await.unwrap();
        assert!(first.refreshed);
        let second = call(&gate, &mock, Some(&first.token)).await.unwrap();
        assert!(!second.refreshed);
        assert_eq!(second.token, first.token);
        assert!(second
            .retry_after_secs
            .is_some_and(|secs| (1..=30).contains(&secs)));
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn a_failed_refresh_is_answered_from_memory_for_a_few_seconds() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", HOUR, HOUR));
        mock.fail.store(true, Ordering::SeqCst);
        for _ in 0..5 {
            assert!(call(&gate, &mock, Some("old")).await.is_err());
        }
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn a_long_lived_token_with_under_an_hour_left_is_renewed_once() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", 6 * HOUR, HOUR / 2));
        let lease = call(&gate, &mock, None).await.unwrap();
        assert_eq!(lease.token, "token-1");
        assert!(lease.refreshed);
        // The new token (1h life) has room left: later calls do not refresh again.
        for _ in 0..10 {
            let lease = call(&gate, &mock, None).await.unwrap();
            assert_eq!(lease.token, "token-1");
            assert!(!lease.refreshed);
        }
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn early_renewal_of_a_burst_refreshes_once() {
        let gate = Arc::new(LeaseGate::default());
        let mock = Arc::new(Mock::new("old", 6 * HOUR, HOUR / 4));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let (gate, mock) = (gate.clone(), mock.clone());
                tokio::spawn(async move { call(&gate, &mock, None).await })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.await.unwrap().unwrap().token, "token-1");
        }
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn plenty_left_or_a_short_life_is_not_renewed_early() {
        // 6h token with 3h left.
        let (gate, mock) = (LeaseGate::default(), Mock::new("long", 6 * HOUR, 3 * HOUR));
        assert_eq!(call(&gate, &mock, None).await.unwrap().token, "long");
        // Issued with 30 min (Copilot-like, or lifetime unknown = 0): left alone.
        for lifetime in [HOUR / 2, 0] {
            let mock = Mock::new("short", lifetime, HOUR / 4);
            let lease = call(&gate, &mock, None).await.unwrap();
            assert_eq!(lease.token, "short");
            assert!(!lease.refreshed);
            assert_eq!(mock.refreshes(), 0);
        }
    }

    #[tokio::test]
    async fn early_renewal_respects_the_cooldown() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", 6 * HOUR, HOUR / 2));
        call(&gate, &mock, None).await.unwrap();
        // Another near-expiry token shows up right away: no second eviction within 30 s.
        *mock.cache.lock().unwrap() = Some(view("old2", 6 * HOUR, HOUR / 2));
        let lease = call(&gate, &mock, None).await.unwrap();
        assert_eq!(lease.token, "old2");
        assert!(lease.retry_after_secs.is_none());
        assert_eq!(mock.refreshes(), 1);
    }

    #[tokio::test]
    async fn a_failed_early_renewal_keeps_serving_the_token_that_still_works() {
        let (gate, mock) = (LeaseGate::default(), Mock::new("old", 6 * HOUR, HOUR / 2));
        mock.fail.store(true, Ordering::SeqCst);
        for _ in 0..4 {
            let lease = call(&gate, &mock, None).await.unwrap();
            assert_eq!(lease.token, "old");
            assert!(!lease.refreshed);
        }
        assert_eq!(
            mock.refreshes(),
            1,
            "the failure backoff keeps the endpoint quiet"
        );
    }

    #[test]
    fn early_renewal_is_capped_at_half_the_lifetime() {
        // 70 min life: threshold is 35 min, not 60.
        let early =
            |remaining: i64| should_refresh_early(&view("t", 70 * 60_000, remaining), now_ms());
        assert!(!early(40 * 60_000));
        assert!(early(30 * 60_000));
    }
}
