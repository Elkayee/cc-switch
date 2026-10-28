//! HTTP代理服务器
//!
//! 基于Axum的HTTP服务器，处理代理请求
//!
//! Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
//! that the original header-name casing from the CLI client is captured in a
//! `HeaderCaseMap` extension.  This map is later forwarded to the upstream via
//! the hyper-based HTTP client, producing wire-level header casing identical to
//! a direct (non-proxied) CLI request.

use super::{
    failover_switch::FailoverSwitchManager,
    handlers,
    log_codes::srv as log_srv,
    provider_router::ProviderRouter,
    providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
    types::*,
    ProxyError,
};
use crate::database::Database;
use axum::{
    extract::{DefaultBodyLimit, State},
    response::IntoResponse,
    routing::{any, get, post},
    Json, Router,
};
use hyper_util::rt::TokioIo;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;
use tower::util::ServiceExt;

/// 代理服务器状态（共享）
#[derive(Clone)]
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub start_time: Arc<RwLock<Option<std::time::Instant>>>,
    /// 每个应用类型当前使用的 provider (app_type -> (provider_id, provider_name))
    pub current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 共享的 ProviderRouter（持有熔断器状态，跨请求保持）
    pub provider_router: Arc<ProviderRouter>,
    /// Gemini Native shadow state，用于 thoughtSignature / tool call 回放
    pub gemini_shadow: Arc<GeminiShadowStore>,
    /// Codex Chat bridge history，用于恢复 previous_response_id 指向的 tool call
    pub codex_chat_history: Arc<CodexChatHistoryStore>,
    /// AppHandle，用于发射事件和更新托盘菜单
    pub app_handle: Option<tauri::AppHandle<crate::AppRuntime>>,
    /// 故障转移切换管理器
    pub failover_manager: Arc<FailoverSwitchManager>,
}

/// 代理HTTP服务器
pub struct ProxyServer {
    config: ProxyConfig,
    state: ProxyState,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    /// 服务器任务句柄，用于等待服务器实际关闭
    server_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

#[cfg(test)]
impl ProxyState {
    /// 测试用：用这个数据库、其余都是默认值的状态。
    pub(crate) fn for_test(db: Arc<Database>) -> Self {
        ProxyServer::new(ProxyConfig::default(), db, None).state
    }
}

impl ProxyServer {
    pub fn new(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle<crate::AppRuntime>>,
    ) -> Self {
        // 创建共享的 ProviderRouter（熔断器状态将跨所有请求保持）
        let provider_router = Arc::new(ProviderRouter::new(db.clone()));
        // 创建故障转移切换管理器
        let failover_manager = Arc::new(FailoverSwitchManager::new());

        let state = ProxyState {
            db,
            config: Arc::new(RwLock::new(config.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router,
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle,
            failover_manager,
        };

        Self {
            config,
            state,
            shutdown_tx: Arc::new(RwLock::new(None)),
            server_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self) -> Result<ProxyServerInfo, ProxyError> {
        // 检查是否已在运行
        if self.shutdown_tx.read().await.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let addr: SocketAddr =
            format!("{}:{}", self.config.listen_address, self.config.listen_port)
                .parse()
                .map_err(|e| ProxyError::BindFailed(format!("Invalid address: {e}")))?;

        if listen_addr_in_use(addr).await {
            return Err(ProxyError::BindFailed(port_in_use_message(addr.port())));
        }

        // 创建关闭通道
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // 构建路由
        let app = self.build_router();

        // 绑定监听器
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| ProxyError::BindFailed(map_bind_error(addr.port(), e)))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let actual_port = local_addr.port();

        log::info!("[{}] 代理服务器启动于 {local_addr}", log_srv::STARTED);

        // 更新全局代理端口，用于系统代理检测
        crate::proxy::http_client::set_proxy_port(actual_port);

        // 保存关闭句柄
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 更新状态
        let mut status = self.state.status.write().await;
        status.running = true;
        status.address = self.config.listen_address.clone();
        status.port = actual_port;
        drop(status);

        // 记录启动时间
        *self.state.start_time.write().await = Some(std::time::Instant::now());

        // 启动服务器 — 使用手动 hyper HTTP/1.1 accept loop
        // 开启 preserve_header_case 以捕获客户端请求头的原始大小写
        let state = self.state.clone();
        let handle = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, remote_addr) = match result {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("[{SRV}] accept 失败: {e}", SRV = log_srv::ACCEPT_ERR);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };

                        let app = app.clone();
                        let peer = super::direct_token::PeerAddr(remote_addr);
                        tokio::spawn(async move {
                            // Peek raw TCP bytes to capture original header casing
                            // before hyper parses (and lowercases) the header names.
                            let original_cases = {
                                let mut peek_buf = vec![0u8; 8192];
                                match stream.peek(&mut peek_buf).await {
                                    Ok(n) => {
                                        let cases = super::hyper_client::OriginalHeaderCases::from_raw_bytes(&peek_buf[..n]);
                                        log::debug!(
                                            "[ProxyServer] Peeked {} bytes, captured {} header casings",
                                            n, cases.cases.len()
                                        );
                                        cases
                                    }
                                    Err(e) => {
                                        log::debug!("[ProxyServer] peek failed (non-fatal): {e}");
                                        super::hyper_client::OriginalHeaderCases::default()
                                    }
                                }
                            };

                            // service_fn 将 axum Router（tower::Service）桥接到 hyper
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let mut router = app.clone();
                                let cases = original_cases.clone();
                                async move {
                                    // 将 hyper::body::Incoming 转为 axum::body::Body，保留 extensions
                                    let (mut parts, body) = req.into_parts();

                                    // Insert our own header case map alongside hyper's internal one
                                    parts.extensions.insert(cases);
                                    parts.extensions.insert(peer);

                                    let body = axum::body::Body::new(body);
                                    let axum_req = http::Request::from_parts(parts, body);
                                    <Router as tower::Service<http::Request<axum::body::Body>>>::call(&mut router, axum_req).await
                                }
                            });

                            if let Err(e) = hyper::server::conn::http1::Builder::new()
                                .preserve_header_case(true)
                                .serve_connection(TokioIo::new(stream), service)
                                .await
                            {
                                // Connection reset / broken pipe 等在代理场景下很常见，debug 级别
                                log::debug!("[{SRV}] connection error: {e}", SRV = log_srv::CONN_ERR);
                            }
                        });
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }

            // 服务器停止后更新状态
            state.status.write().await.running = false;
            *state.start_time.write().await = None;
        });

        // 保存服务器任务句柄
        *self.server_handle.write().await = Some(handle);

        Ok(ProxyServerInfo {
            address: self.config.listen_address.clone(),
            port: actual_port,
            started_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        } else {
            return Err(ProxyError::NotRunning);
        }

        // 2. 等待服务器任务结束（带 5 秒超时保护）
        if let Some(handle) = self.server_handle.write().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {
                    log::info!("[{}] 代理服务器已完全停止", log_srv::STOPPED);
                    Ok(())
                }
                Ok(Err(e)) => {
                    log::warn!("[{}] 代理服务器任务异常终止: {e}", log_srv::TASK_ERROR);
                    Err(ProxyError::StopFailed(e.to_string()))
                }
                Err(_) => {
                    log::warn!(
                        "[{}] 代理服务器停止超时（5秒），强制继续",
                        log_srv::STOP_TIMEOUT
                    );
                    Err(ProxyError::StopTimeout)
                }
            }
        } else {
            Ok(())
        }
    }

    pub async fn get_status(&self) -> ProxyStatus {
        let mut status = self.state.status.read().await.clone();

        // 计算运行时间
        if let Some(start) = *self.state.start_time.read().await {
            status.uptime_seconds = start.elapsed().as_secs();
        }

        // 从 current_providers HashMap 获取每个应用类型当前正在使用的 provider
        let current_providers = self.state.current_providers.read().await;
        status.active_targets = current_providers
            .iter()
            .map(|(app_type, (provider_id, provider_name))| ActiveTarget {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                provider_name: provider_name.clone(),
            })
            .collect();

        status
    }

    /// 更新某个应用类型当前“目标供应商”（用于 UI 展示 active_targets）
    ///
    /// 注意：这不代表该供应商一定已经处理过请求，而是用于“热切换/启用故障转移立即切 P1”
    /// 等场景下，让 UI 能立刻反映最新目标。
    pub async fn set_active_target(&self, app_type: &str, provider_id: &str, provider_name: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.insert(
            app_type.to_string(),
            (provider_id.to_string(), provider_name.to_string()),
        );
    }

    fn route_table() -> Router<ProxyState> {
        Router::new()
            // 健康检查
            .route("/health", get(handlers::health_check))
            .route("/status", get(handlers::get_status))
            // 托管 OAuth 的直连 token（仅本机、非浏览器调用方）
            .route(
                "/auth/token/:app/:provider_id",
                get(super::direct_token::handle_direct_token),
            )
            // Claude API (支持带前缀和不带前缀两种格式)
            .route("/v1/messages", post(handlers::handle_messages))
            .route("/claude/v1/messages", post(handlers::handle_messages))
            // Claude Desktop 3P 本地 gateway（独立 provider namespace）
            .route(
                "/claude-desktop/v1/models",
                get(handlers::handle_claude_desktop_models),
            )
            .route(
                "/claude-desktop/v1/messages",
                post(handlers::handle_claude_desktop_messages),
            )
            // OpenAI Chat Completions API (Codex CLI，支持带前缀和不带前缀)
            .route("/chat/completions", post(handlers::handle_chat_completions))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/v1/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/codex/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            // OpenAI Models API (Codex CLI reachability check)
            .route("/models", get(handlers::handle_models))
            .route("/v1/models", get(handlers::handle_models))
            // OpenAI Responses API (Codex CLI，支持带前缀和不带前缀)。GET 是 WebSocket
            // 握手：Codex 内置的 openai（代理的官方路由）会先试 WebSocket。
            .route(
                "/responses",
                post(handlers::handle_responses).get(handlers::handle_responses_websocket),
            )
            .route(
                "/v1/responses",
                post(handlers::handle_responses).get(handlers::handle_responses_websocket),
            )
            .route(
                "/v1/v1/responses",
                post(handlers::handle_responses).get(handlers::handle_responses_websocket),
            )
            .route(
                "/codex/v1/responses",
                post(handlers::handle_responses).get(handlers::handle_responses_websocket),
            )
            // Grok Build uses the Responses protocol but has an independent
            // provider namespace and failover queue.
            .route(
                "/grokbuild/v1/responses",
                post(handlers::handle_grokbuild_responses),
            )
            // OpenAI Responses Compact API (Codex CLI 远程压缩，透传)
            .route(
                "/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/codex/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/grokbuild/v1/responses/compact",
                post(handlers::handle_grokbuild_responses_compact),
            )
            // Codex standalone Alpha Search API. All local aliases normalize to
            // the selected provider's canonical sibling `/alpha/search` route.
            .route("/alpha/search", post(handlers::handle_alpha_search))
            .route("/v1/alpha/search", post(handlers::handle_alpha_search))
            .route("/v1/v1/alpha/search", post(handlers::handle_alpha_search))
            .route(
                "/codex/v1/alpha/search",
                post(handlers::handle_alpha_search),
            )
            // Codex built-in ImageGen still calls the legacy OpenAI Images API.
            .route(
                "/images/generations",
                post(handlers::handle_images_generations),
            )
            .route(
                "/v1/images/generations",
                post(handlers::handle_images_generations),
            )
            .route(
                "/v1/v1/images/generations",
                post(handlers::handle_images_generations),
            )
            .route(
                "/codex/v1/images/generations",
                post(handlers::handle_images_generations),
            )
            // Codex ImageGen posts to `/images/edits` when it references existing images.
            .route("/images/edits", post(handlers::handle_images_edits))
            .route("/v1/images/edits", post(handlers::handle_images_edits))
            .route("/v1/v1/images/edits", post(handlers::handle_images_edits))
            .route(
                "/codex/v1/images/edits",
                post(handlers::handle_images_edits),
            )
            // Gemini API (支持带前缀和不带前缀)
            //
            // 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
            // `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
            // GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
            // 请求会在路由层 404，绕过本地代理的统计、整流和故障转移。
            .route("/v1beta/*path", any(handlers::handle_gemini))
            .route("/gemini/v1beta/*path", any(handlers::handle_gemini))
            // Gemini 的 GA 版本也叫 /v1，给原 SDK 留一条出口
            .route("/gemini/v1/*path", any(handlers::handle_gemini))
            // 提高默认请求体大小限制（避免 413 Payload Too Large）
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
    }

    fn build_router(&self) -> Router {
        let state = self.state.clone();
        let dispatch = Self::route_table().with_state(state.clone());
        Self::route_table()
            .fallback(
                move |State(state): State<ProxyState>, request: axum::extract::Request| {
                    let dispatch = dispatch.clone();
                    async move { dispatch_pinned(state, dispatch, request).await }
                },
            )
            .with_state(state)
    }

    /// 在不重启服务的情况下更新运行时配置
    pub async fn apply_runtime_config(&self, config: &ProxyConfig) {
        *self.state.config.write().await = config.clone();
    }

    /// 热更新熔断器配置
    ///
    /// 将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state.provider_router.update_all_configs(config).await;
    }

    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state
            .provider_router
            .update_app_configs(app_type, config)
            .await;
    }

    /// 重置指定 Provider 的熔断器
    pub async fn reset_provider_circuit_breaker(&self, provider_id: &str, app_type: &str) {
        self.state
            .provider_router
            .reset_provider_breaker(provider_id, app_type)
            .await;
    }
}

fn probe_socket_addr(addr: SocketAddr) -> SocketAddr {
    if !addr.ip().is_unspecified() {
        return addr;
    }
    let ip = if addr.is_ipv4() {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    };
    SocketAddr::new(ip, addr.port())
}

fn port_in_use_message(port: u16) -> String {
    format!("Port {port} is already in use; startup cancelled (the process holding the port was not killed)")
}

fn map_bind_error(port: u16, err: std::io::Error) -> String {
    if err.kind() == ErrorKind::AddrInUse {
        port_in_use_message(port)
    } else {
        err.to_string()
    }
}

async fn listen_addr_in_use(addr: SocketAddr) -> bool {
    if addr.port() == 0 {
        return false;
    }
    tokio::time::timeout(
        Duration::from_millis(300),
        tokio::net::TcpStream::connect(probe_socket_addr(addr)),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some()
}

async fn dispatch_pinned(
    state: ProxyState,
    dispatch: Router,
    request: axum::extract::Request,
) -> axum::response::Response {
    let discovery = handlers::is_claude_model_discovery(request.uri(), request.headers());
    let path = request.uri().path().to_string();
    let query = request.uri().query().map(str::to_string);
    let classified = super::provider_pin::classify_provider_pin(&path, query.as_deref(), discovery);
    let super::provider_pin::PinClass::Pin {
        id,
        app,
        path,
        query,
    } = classified
    else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    let provider = match state.db.get_provider_by_id(&id, app.as_str()) {
        Ok(Some(provider)) => provider,
        Ok(None) => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": {
                        "message": format!("provider {id} not found for {}", app.as_str()),
                        "type": "proxy_error",
                    }
                })),
            )
                .into_response();
        }
        Err(error) => return ProxyError::DatabaseError(error.to_string()).into_response(),
    };
    let (mut parts, body) = request.into_parts();
    let rewritten = match query {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let Ok(uri) = rewritten.parse() else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    parts.uri = uri;
    parts
        .extensions
        .insert(super::provider_pin::PinnedProvider { provider });
    let request = axum::extract::Request::from_parts(parts, body);
    dispatch
        .oneshot(request)
        .await
        .unwrap_or_else(|error| match error {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, ProviderMeta};
    use crate::AppError;
    use axum::http::{header, HeaderMap, StatusCode};
    use serde_json::{json, Value};
    use tokio::sync::Mutex;

    #[derive(Debug)]
    struct CapturedRequest {
        path_and_query: String,
        authorization: Option<String>,
        body: Value,
    }

    /// Windows 上监听 socket 不能被子进程继承：从 CC Switch 拉起的终端、CLI 一旦继承它，
    /// 退出后端口仍被占着，下次启动报 os error 10048（#8552）。mio 1.2.1 起才带
    /// WSA_FLAG_NO_HANDLE_INHERIT，这里防止 Cargo.lock 退回旧版本。
    #[cfg(windows)]
    #[tokio::test]
    async fn listener_socket_is_not_inheritable_on_windows() {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind listener");
        let mut flags = 0u32;
        let ok = unsafe { GetHandleInformation(listener.as_raw_socket() as HANDLE, &mut flags) };
        assert_ne!(ok, 0, "GetHandleInformation failed");
        assert_eq!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "listener socket is inheritable"
        );
    }

    /// Codex 内置的 openai 先用 WebSocket 连 Responses：握手回 426 它才立刻改走 HTTP。
    #[tokio::test]
    async fn responses_websocket_handshake_is_answered_with_upgrade_required() {
        let db = Arc::new(Database::memory().expect("memory database"));
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        for path in [
            "/responses",
            "/v1/responses",
            "/v1/v1/responses",
            "/codex/v1/responses",
        ] {
            let response = client
                .get(format!("http://127.0.0.1:{}{path}", proxy_info.port))
                .header(header::CONNECTION, "Upgrade")
                .header(header::UPGRADE, "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .send()
                .await
                .expect("websocket handshake");
            assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED, "{path}");
        }
        proxy.stop().await.expect("stop test proxy");
    }

    /// A base URL pasted as a complete endpoint with the full-URL switch left off
    /// must derive the sibling standalone endpoint instead of having the
    /// standalone path appended to it.
    #[tokio::test]
    async fn codex_standalone_endpoints_derive_from_pasted_full_base_url() {
        let captured = Arc::new(Mutex::new(Vec::<CapturedRequest>::new()));
        let capture_handler = {
            let captured = captured.clone();
            move |request: axum::extract::Request| {
                let captured = captured.clone();
                async move {
                    let (parts, _body) = request.into_parts();
                    captured.lock().await.push(CapturedRequest {
                        path_and_query: parts
                            .uri
                            .path_and_query()
                            .map(|value| value.as_str().to_string())
                            .unwrap_or_else(|| parts.uri.path().to_string()),
                        authorization: parts
                            .headers
                            .get(header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(ToString::to_string),
                        body: Value::Null,
                    });

                    (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"created":1,"data":[{"b64_json":"aW1hZ2U="}],"usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}"#,
                    )
                }
            }
        };
        let mock_app = Router::new()
            .route("/v1/images/generations", post(capture_handler.clone()))
            .route("/v1/images/edits", post(capture_handler.clone()))
            .route("/Gateway/v1/images/edits", post(capture_handler.clone()))
            .route("/v1/alpha/search", post(capture_handler));
        let mock_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let mock_addr = mock_listener.local_addr().expect("mock upstream address");
        let mock_handle = tokio::spawn(async move {
            axum::serve(mock_listener, mock_app)
                .await
                .expect("serve mock upstream");
        });

        let db = Arc::new(Database::memory().expect("memory database"));
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();

        let cases = [
            (
                "pasted-mixed-case-chat-completions",
                format!("http://{mock_addr}/v1/Chat/Completions?api-version=CaseValue"),
                "/v1/images/edits",
                "/v1/images/edits?api-version=CaseValue&client_version=0.145.0",
            ),
            (
                "pasted-mixed-case-images-generations",
                format!("http://{mock_addr}/Gateway/v1/Images/Generations/?api-version=CaseValue#fragment"),
                "/v1/images/edits",
                "/Gateway/v1/images/edits?api-version=CaseValue&client_version=0.145.0",
            ),
            (
                "pasted-mixed-case-images-edits",
                format!("http://{mock_addr}/v1/Images/Edits/"),
                "/v1/images/generations",
                "/v1/images/generations?client_version=0.145.0",
            ),
            (
                "pasted-mixed-case-responses-compact",
                format!("http://{mock_addr}/v1/Responses/Compact/"),
                "/v1/alpha/search",
                "/v1/alpha/search?client_version=0.145.0",
            ),
            (
                "pasted-chat-completions",
                format!("http://{mock_addr}/v1/chat/completions"),
                "/v1/images/generations",
                "/v1/images/generations?client_version=0.145.0",
            ),
            (
                "pasted-chat-completions",
                format!("http://{mock_addr}/v1/chat/completions"),
                "/v1/images/edits",
                "/v1/images/edits?client_version=0.145.0",
            ),
            (
                "pasted-images-generations",
                format!("http://{mock_addr}/v1/images/generations?api-version=test"),
                "/v1/images/edits",
                "/v1/images/edits?api-version=test&client_version=0.145.0",
            ),
            (
                "pasted-responses",
                format!("http://{mock_addr}/v1/responses"),
                "/v1/alpha/search",
                "/v1/alpha/search?client_version=0.145.0",
            ),
        ];

        for (provider_id, base_url, local_path, expected_upstream) in cases {
            let provider = Provider::with_id(
                provider_id.to_string(),
                provider_id.to_string(),
                json!({
                    "base_url": base_url,
                    "auth": {"OPENAI_API_KEY": "upstream-secret"}
                }),
                None,
            );
            db.save_provider("codex", &provider)
                .expect("save pasted base URL provider");
            db.set_current_provider("codex", &provider.id)
                .expect("select pasted base URL provider");

            let response = client
                .post(format!(
                    "http://127.0.0.1:{}{local_path}?client_version=0.145.0",
                    proxy_info.port
                ))
                .header(header::AUTHORIZATION, "Bearer client-secret")
                .json(&json!({"model": "gpt-image-1", "prompt": "pasted base URL"}))
                .send()
                .await
                .expect("send images request");

            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{local_path} via {base_url}"
            );
            let request = captured
                .lock()
                .await
                .pop()
                .expect("upstream request captured");
            assert_eq!(
                request.path_and_query, expected_upstream,
                "{local_path} via {base_url}"
            );
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer upstream-secret")
            );
        }

        proxy.stop().await.expect("stop test proxy");
        mock_handle.abort();
    }

    #[tokio::test]
    async fn codex_images_generation_aliases_forward_and_record_usage() {
        let captured = Arc::new(Mutex::new(Vec::<CapturedRequest>::new()));
        let mock_app = Router::new().route(
            "/v1/images/generations",
            post({
                let captured = captured.clone();
                move |request: axum::extract::Request| {
                    let captured = captured.clone();
                    async move {
                        let (parts, body) = request.into_parts();
                        let body = axum::body::to_bytes(body, 1024 * 1024)
                            .await
                            .expect("read mock request body");
                        captured.lock().await.push(CapturedRequest {
                            path_and_query: parts
                                .uri
                                .path_and_query()
                                .map(|value| value.as_str().to_string())
                                .unwrap_or_else(|| parts.uri.path().to_string()),
                            authorization: parts
                                .headers
                                .get(header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .map(ToString::to_string),
                            body: serde_json::from_slice(&body).expect("parse mock request body"),
                        });

                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            r#"{"created":1,"data":[{"b64_json":"aW1hZ2U="}],"usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}"#,
                        )
                    }
                }
            }),
        );
        let mock_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let mock_addr = mock_listener.local_addr().expect("mock upstream address");
        let mock_handle = tokio::spawn(async move {
            axum::serve(mock_listener, mock_app)
                .await
                .expect("serve mock upstream");
        });

        let db = Arc::new(Database::memory().expect("memory database"));
        let provider = Provider::with_id(
            "images-api-upstream".to_string(),
            "Images API Upstream".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1"),
                "auth": {"OPENAI_API_KEY": "upstream-secret"}
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save test provider");
        db.set_current_provider("codex", &provider.id)
            .expect("select test provider");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: true,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let aliases = [
            "/images/generations",
            "/v1/images/generations",
            "/v1/v1/images/generations",
            "/codex/v1/images/generations",
        ];

        for (index, path) in aliases.iter().enumerate() {
            let response = client
                .post(format!(
                    "http://127.0.0.1:{}{}?client_version=0.145.0",
                    proxy_info.port, path
                ))
                .header(header::AUTHORIZATION, "Bearer client-secret")
                .json(&json!({
                    "model": "gpt-image-1",
                    "prompt": format!("image generation alias {index}")
                }))
                .send()
                .await
                .expect("send images request");

            assert_eq!(response.status(), StatusCode::OK, "alias {path}");
            assert_eq!(
                response.text().await.expect("read proxy response"),
                r#"{"created":1,"data":[{"b64_json":"aW1hZ2U="}],"usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}"#,
                "alias {path}"
            );
        }

        let (log_count, input_tokens, output_tokens): (i64, i64, i64) =
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let totals = {
                        let conn = crate::database::lock_conn!(db.conn);
                        match conn.query_row(
                            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
                             FROM proxy_request_logs WHERE provider_id = ?1",
                            ["images-api-upstream"],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        ) {
                            Ok(totals) => totals,
                            Err(error) => panic!("query images usage logs: {error}"),
                        }
                    };

                    if totals.0 == aliases.len() as i64 {
                        break Ok::<_, AppError>(totals);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("images usage logs were not recorded")
            .expect("read images usage logs");
        assert_eq!(log_count, aliases.len() as i64);
        assert_eq!(input_tokens, 7 * aliases.len() as i64);
        assert_eq!(output_tokens, 11 * aliases.len() as i64);

        let mut full_url_provider = Provider::with_id(
            "images-api-full-url".to_string(),
            "Images API Full URL".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1/responses?api-version=test"),
                "auth": {"OPENAI_API_KEY": "full-url-secret"}
            }),
            None,
        );
        full_url_provider.meta = Some(ProviderMeta {
            is_full_url: Some(true),
            ..ProviderMeta::default()
        });
        db.save_provider("codex", &full_url_provider)
            .expect("save full URL images provider");
        db.set_current_provider("codex", &full_url_provider.id)
            .expect("select full URL images provider");

        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1/images/generations?client_version=0.145.0",
                proxy_info.port
            ))
            .header(header::AUTHORIZATION, "Bearer client-secret")
            .json(&json!({
                "model": "gpt-image-1",
                "prompt": "image generation full URL"
            }))
            .send()
            .await
            .expect("send full URL images request");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.text().await.expect("read full URL image response"),
            r#"{"created":1,"data":[{"b64_json":"aW1hZ2U="}],"usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}"#
        );

        let captured = captured.lock().await;
        assert_eq!(captured.len(), aliases.len() + 1);
        for (index, request) in captured.iter().take(aliases.len()).enumerate() {
            assert_eq!(
                request.path_and_query,
                "/v1/images/generations?client_version=0.145.0"
            );
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer upstream-secret")
            );
            assert_eq!(request.body["model"], "gpt-image-1");
            assert_eq!(
                request.body["prompt"],
                format!("image generation alias {index}")
            );
        }

        let full_url_request = captured.last().expect("full URL image request captured");
        assert_eq!(
            full_url_request.path_and_query,
            "/v1/images/generations?api-version=test&client_version=0.145.0"
        );
        assert_eq!(
            full_url_request.authorization.as_deref(),
            Some("Bearer full-url-secret")
        );
        assert_eq!(full_url_request.body["model"], "gpt-image-1");
        assert_eq!(full_url_request.body["prompt"], "image generation full URL");

        proxy.stop().await.expect("stop test proxy");
        mock_handle.abort();
    }

    #[tokio::test]
    async fn codex_images_edit_aliases_forward_and_record_usage() {
        // Real Images API responses carry `input_tokens_details` with text/image
        // splits; the shared Codex usage parser must tolerate them.
        const UPSTREAM_BODY: &str = r#"{"created":1,"data":[{"b64_json":"ZWRpdA=="}],"usage":{"input_tokens":13,"output_tokens":17,"total_tokens":30,"input_tokens_details":{"text_tokens":5,"image_tokens":8}}}"#;
        const IMAGE_DATA_URL: &str = "data:image/png;base64,Zm9v";

        let captured = Arc::new(Mutex::new(Vec::<CapturedRequest>::new()));
        let mock_app = Router::new().route(
            "/v1/images/edits",
            post({
                let captured = captured.clone();
                move |request: axum::extract::Request| {
                    let captured = captured.clone();
                    async move {
                        let (parts, body) = request.into_parts();
                        let body = axum::body::to_bytes(body, 1024 * 1024)
                            .await
                            .expect("read mock request body");
                        captured.lock().await.push(CapturedRequest {
                            path_and_query: parts
                                .uri
                                .path_and_query()
                                .map(|value| value.as_str().to_string())
                                .unwrap_or_else(|| parts.uri.path().to_string()),
                            authorization: parts
                                .headers
                                .get(header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .map(ToString::to_string),
                            body: serde_json::from_slice(&body).expect("parse mock request body"),
                        });

                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            UPSTREAM_BODY,
                        )
                    }
                }
            }),
        );
        let mock_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let mock_addr = mock_listener.local_addr().expect("mock upstream address");
        let mock_handle = tokio::spawn(async move {
            axum::serve(mock_listener, mock_app)
                .await
                .expect("serve mock upstream");
        });

        let db = Arc::new(Database::memory().expect("memory database"));
        let provider = Provider::with_id(
            "images-edit-upstream".to_string(),
            "Images Edit Upstream".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1"),
                "auth": {"OPENAI_API_KEY": "upstream-secret"}
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save test provider");
        db.set_current_provider("codex", &provider.id)
            .expect("select test provider");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: true,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let aliases = [
            "/images/edits",
            "/v1/images/edits",
            "/v1/v1/images/edits",
            "/codex/v1/images/edits",
        ];

        for (index, path) in aliases.iter().enumerate() {
            let response = client
                .post(format!(
                    "http://127.0.0.1:{}{}?client_version=0.145.0",
                    proxy_info.port, path
                ))
                .header(header::AUTHORIZATION, "Bearer client-secret")
                .json(&json!({
                    "model": "gpt-image-2",
                    "prompt": format!("image edit alias {index}"),
                    "images": [{"image_url": IMAGE_DATA_URL}]
                }))
                .send()
                .await
                .expect("send images edit request");

            assert_eq!(response.status(), StatusCode::OK, "alias {path}");
            assert_eq!(
                response.text().await.expect("read proxy response"),
                UPSTREAM_BODY,
                "alias {path}"
            );
        }

        let (log_count, input_tokens, output_tokens): (i64, i64, i64) =
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let totals = {
                        let conn = crate::database::lock_conn!(db.conn);
                        match conn.query_row(
                            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
                             FROM proxy_request_logs WHERE provider_id = ?1",
                            ["images-edit-upstream"],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        ) {
                            Ok(totals) => totals,
                            Err(error) => panic!("query images edit usage logs: {error}"),
                        }
                    };

                    if totals.0 == aliases.len() as i64 {
                        break Ok::<_, AppError>(totals);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("images edit usage logs were not recorded")
            .expect("read images edit usage logs");
        assert_eq!(log_count, aliases.len() as i64);
        assert_eq!(input_tokens, 13 * aliases.len() as i64);
        assert_eq!(output_tokens, 17 * aliases.len() as i64);

        // A full URL pasted for the sibling generations route must derive
        // `/images/edits` instead of posting edit payloads to generations.
        let mut full_url_provider = Provider::with_id(
            "images-edit-full-url".to_string(),
            "Images Edit Full URL".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1/images/generations?api-version=test"),
                "auth": {"OPENAI_API_KEY": "full-url-secret"}
            }),
            None,
        );
        full_url_provider.meta = Some(ProviderMeta {
            is_full_url: Some(true),
            ..ProviderMeta::default()
        });
        db.save_provider("codex", &full_url_provider)
            .expect("save full URL images edit provider");
        db.set_current_provider("codex", &full_url_provider.id)
            .expect("select full URL images edit provider");

        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1/images/edits?client_version=0.145.0",
                proxy_info.port
            ))
            .header(header::AUTHORIZATION, "Bearer client-secret")
            .json(&json!({
                "model": "gpt-image-2",
                "prompt": "image edit full URL",
                "images": [{"image_url": IMAGE_DATA_URL}]
            }))
            .send()
            .await
            .expect("send full URL images edit request");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .text()
                .await
                .expect("read full URL image edit response"),
            UPSTREAM_BODY
        );

        let captured = captured.lock().await;
        assert_eq!(captured.len(), aliases.len() + 1);
        for (index, request) in captured.iter().take(aliases.len()).enumerate() {
            assert_eq!(
                request.path_and_query,
                "/v1/images/edits?client_version=0.145.0"
            );
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer upstream-secret")
            );
            assert_eq!(request.body["model"], "gpt-image-2");
            assert_eq!(request.body["prompt"], format!("image edit alias {index}"));
            assert_eq!(request.body["images"][0]["image_url"], IMAGE_DATA_URL);
        }

        let full_url_request = captured
            .last()
            .expect("full URL image edit request captured");
        assert_eq!(
            full_url_request.path_and_query,
            "/v1/images/edits?api-version=test&client_version=0.145.0"
        );
        assert_eq!(
            full_url_request.authorization.as_deref(),
            Some("Bearer full-url-secret")
        );
        assert_eq!(full_url_request.body["model"], "gpt-image-2");
        assert_eq!(full_url_request.body["prompt"], "image edit full URL");
        assert_eq!(
            full_url_request.body["images"][0]["image_url"],
            IMAGE_DATA_URL
        );

        proxy.stop().await.expect("stop test proxy");
        mock_handle.abort();
    }

    #[tokio::test]
    async fn alpha_search_routes_forward_to_canonical_upstream() {
        let captured = Arc::new(Mutex::new(Vec::<CapturedRequest>::new()));
        let mock_app = Router::new().route(
            "/v1/alpha/search",
            post({
                let captured = captured.clone();
                move |request: axum::extract::Request| {
                    let captured = captured.clone();
                    async move {
                        let (parts, body) = request.into_parts();
                        let body = axum::body::to_bytes(body, 1024 * 1024)
                            .await
                            .expect("read mock request body");
                        captured.lock().await.push(CapturedRequest {
                            path_and_query: parts
                                .uri
                                .path_and_query()
                                .map(|value| value.as_str().to_string())
                                .unwrap_or_else(|| parts.uri.path().to_string()),
                            authorization: parts
                                .headers
                                .get(header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .map(ToString::to_string),
                            body: serde_json::from_slice(&body).expect("parse mock request body"),
                        });

                        let mut headers = HeaderMap::new();
                        headers.insert(
                            header::CONTENT_TYPE,
                            "application/json".parse().expect("content type"),
                        );
                        headers.insert(
                            "x-upstream-request-id",
                            "search-1".parse().expect("request id"),
                        );
                        (
                            StatusCode::ACCEPTED,
                            headers,
                            r#"{"encrypted_output":"ciphertext"}"#,
                        )
                    }
                }
            }),
        );
        let mock_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let mock_addr = mock_listener.local_addr().expect("mock upstream address");
        let mock_handle = tokio::spawn(async move {
            axum::serve(mock_listener, mock_app)
                .await
                .expect("serve mock upstream");
        });

        let db = Arc::new(Database::memory().expect("memory database"));
        let provider = Provider::with_id(
            "alpha-search-upstream".to_string(),
            "Alpha Search Upstream".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1"),
                "auth": {"OPENAI_API_KEY": "upstream-secret"}
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save test provider");
        db.set_current_provider("codex", &provider.id)
            .expect("select test provider");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let aliases = [
            "/alpha/search",
            "/v1/alpha/search",
            "/v1/v1/alpha/search",
            "/codex/v1/alpha/search",
        ];

        for (index, path) in aliases.iter().enumerate() {
            let response = client
                .post(format!(
                    "http://127.0.0.1:{}{}?client_version=0.144.6",
                    proxy_info.port, path
                ))
                .header(header::AUTHORIZATION, "Bearer client-secret")
                .json(&json!({
                    "id": format!("search-{index}"),
                    "model": "gpt-5.6-sol",
                    "commands": {"search_query": [{"q": "test"}]}
                }))
                .send()
                .await
                .expect("send alpha search request");

            assert_eq!(response.status(), StatusCode::ACCEPTED, "alias {path}");
            assert_eq!(
                response
                    .headers()
                    .get("x-upstream-request-id")
                    .and_then(|value| value.to_str().ok()),
                Some("search-1"),
                "alias {path}"
            );
            assert_eq!(
                response.text().await.expect("read proxy response"),
                r#"{"encrypted_output":"ciphertext"}"#,
                "alias {path}"
            );
        }

        // Full-URL providers were the known flaw in the original PR: without a
        // sibling-endpoint rewrite, this request would be posted back to
        // `/v1/responses` instead of `/v1/alpha/search`.
        let mut full_url_provider = Provider::with_id(
            "alpha-search-full-url".to_string(),
            "Alpha Search Full URL".to_string(),
            json!({
                "base_url": format!("http://{mock_addr}/v1/responses?api-version=test"),
                "auth": {"OPENAI_API_KEY": "full-url-secret"}
            }),
            None,
        );
        full_url_provider.meta = Some(ProviderMeta {
            is_full_url: Some(true),
            ..ProviderMeta::default()
        });
        db.save_provider("codex", &full_url_provider)
            .expect("save full URL provider");
        db.set_current_provider("codex", &full_url_provider.id)
            .expect("select full URL provider");

        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1/alpha/search?client_version=0.144.6",
                proxy_info.port
            ))
            .header(header::AUTHORIZATION, "Bearer client-secret")
            .json(&json!({
                "id": "search-full-url",
                "model": "gpt-5.6-sol",
                "commands": {"search_query": [{"q": "full URL"}]}
            }))
            .send()
            .await
            .expect("send full URL alpha search request");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(
            response.text().await.expect("read full URL response"),
            r#"{"encrypted_output":"ciphertext"}"#
        );

        proxy.stop().await.expect("stop test proxy");
        mock_handle.abort();

        let captured = captured.lock().await;
        assert_eq!(captured.len(), aliases.len() + 1);
        for (index, request) in captured.iter().take(aliases.len()).enumerate() {
            assert_eq!(
                request.path_and_query,
                "/v1/alpha/search?client_version=0.144.6"
            );
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer upstream-secret")
            );
            assert_eq!(request.body["id"], format!("search-{index}"));
            assert_eq!(request.body["model"], "gpt-5.6-sol");
            assert_eq!(request.body["commands"]["search_query"][0]["q"], "test");
        }

        let full_url_request = captured.last().expect("full URL request captured");
        assert_eq!(
            full_url_request.path_and_query,
            "/v1/alpha/search?api-version=test&client_version=0.144.6"
        );
        assert_eq!(
            full_url_request.authorization.as_deref(),
            Some("Bearer full-url-secret")
        );
        assert_eq!(full_url_request.body["id"], "search-full-url");
        assert_eq!(
            full_url_request.body["commands"]["search_query"][0]["q"],
            "full URL"
        );
    }

    #[tokio::test]
    async fn pinned_claude_id_forwards_to_that_provider_not_in_use() {
        async fn mock_upstream() -> (
            std::net::SocketAddr,
            tokio::task::JoinHandle<()>,
            Arc<Mutex<usize>>,
        ) {
            let hits = Arc::new(Mutex::new(0usize));
            let hits_for_route = hits.clone();
            let app = Router::new().route(
                "/v1/messages",
                post(move |request: axum::extract::Request| {
                    let hits_for_route = hits_for_route.clone();
                    async move {
                        let _ = axum::body::to_bytes(request.into_body(), 1024 * 1024).await;
                        *hits_for_route.lock().await += 1;
                        (
                            StatusCode::OK,
                            r#"{"id":"msg","type":"message","role":"assistant","content":[]}"#,
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind mock upstream");
            let addr = listener.local_addr().expect("mock address");
            let handle = tokio::spawn(async move {
                axum::serve(listener, app)
                    .await
                    .expect("serve mock upstream");
            });
            (addr, handle, hits)
        }

        let (in_use_addr, in_use_handle, in_use_hits) = mock_upstream().await;
        let (pinned_addr, pinned_handle, pinned_hits) = mock_upstream().await;
        let db = Arc::new(Database::memory().expect("memory database"));
        let in_use = Provider::with_id(
            "in-use".to_string(),
            "In Use".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": format!("http://{in_use_addr}"),
                    "ANTHROPIC_AUTH_TOKEN": "sk-in-use"
                }
            }),
            None,
        );
        let pinned = Provider::with_id(
            "pinned-id".to_string(),
            "Pinned".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": format!("http://{pinned_addr}"),
                    "ANTHROPIC_AUTH_TOKEN": "sk-pinned"
                }
            }),
            None,
        );
        db.save_provider("claude", &in_use).expect("save in-use");
        db.save_provider("claude", &pinned).expect("save pinned");
        db.set_current_provider("claude", &in_use.id)
            .expect("select in-use");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/pinned-id/v1/messages",
                proxy_info.port
            ))
            .json(&json!({
                "model": "claude-sonnet",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .expect("send pinned request");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(*pinned_hits.lock().await, 1, "pinned upstream was not used");
        assert_eq!(*in_use_hits.lock().await, 0, "pin fell back to In Use");

        let status: Value = client
            .get(format!("http://127.0.0.1:{}/status", proxy_info.port))
            .send()
            .await
            .expect("status")
            .json()
            .await
            .expect("status json");
        assert_eq!(status["failover_count"], 0, "pin incremented failover");
        assert_eq!(
            status["current_provider_id"],
            Value::Null,
            "pin wrote In Use: {status}"
        );

        let unprefixed = client
            .post(format!("http://127.0.0.1:{}/v1/messages", proxy_info.port))
            .json(&json!({
                "model": "claude-sonnet",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .expect("send unprefixed request");
        assert_eq!(unprefixed.status(), StatusCode::OK);
        assert_eq!(*in_use_hits.lock().await, 1, "unprefixed left In Use");
        assert_eq!(*pinned_hits.lock().await, 1, "unprefixed also hit the pin");

        proxy.stop().await.expect("stop test proxy");
        in_use_handle.abort();
        pinned_handle.abort();
    }

    #[tokio::test]
    async fn pinned_failure_does_not_fall_through_to_in_use() {
        async fn mock_upstream(
            status: StatusCode,
        ) -> (
            std::net::SocketAddr,
            tokio::task::JoinHandle<()>,
            Arc<Mutex<usize>>,
        ) {
            let hits = Arc::new(Mutex::new(0usize));
            let hits_for_route = hits.clone();
            let app = Router::new().route(
                "/v1/messages",
                post(move |request: axum::extract::Request| {
                    let hits_for_route = hits_for_route.clone();
                    async move {
                        let _ = axum::body::to_bytes(request.into_body(), 1024 * 1024).await;
                        *hits_for_route.lock().await += 1;
                        (status, r#"{"id":"msg","type":"message"}"#)
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind mock upstream");
            let addr = listener.local_addr().expect("mock address");
            let handle = tokio::spawn(async move {
                axum::serve(listener, app)
                    .await
                    .expect("serve mock upstream");
            });
            (addr, handle, hits)
        }

        let (in_use_addr, in_use_handle, in_use_hits) = mock_upstream(StatusCode::OK).await;
        let (pinned_addr, pinned_handle, pinned_hits) =
            mock_upstream(StatusCode::INTERNAL_SERVER_ERROR).await;
        let db = Arc::new(Database::memory().expect("memory database"));
        let in_use = Provider::with_id(
            "in-use".to_string(),
            "In Use".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": format!("http://{in_use_addr}"),
                    "ANTHROPIC_AUTH_TOKEN": "sk-in-use"
                }
            }),
            None,
        );
        let pinned = Provider::with_id(
            "pinned-id".to_string(),
            "Pinned".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": format!("http://{pinned_addr}"),
                    "ANTHROPIC_AUTH_TOKEN": "sk-pinned"
                }
            }),
            None,
        );
        db.save_provider("claude", &in_use).expect("save in-use");
        db.save_provider("claude", &pinned).expect("save pinned");
        db.set_current_provider("claude", &in_use.id)
            .expect("select in-use");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                non_streaming_timeout: 10,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/pinned-id/v1/messages",
                proxy_info.port
            ))
            .json(&json!({
                "model": "ccs-claude-other--other-model",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .expect("send failing pin");

        assert_ne!(response.status(), StatusCode::OK);
        assert!(
            *pinned_hits.lock().await >= 1,
            "failing pin never reached its provider"
        );
        assert_eq!(*in_use_hits.lock().await, 0, "pin failed over to In Use");

        proxy.stop().await.expect("stop test proxy");
        in_use_handle.abort();
        pinned_handle.abort();
    }

    #[tokio::test]
    async fn pinned_claude_desktop_wrong_token_is_unauthorized() {
        let db = Arc::new(Database::memory().expect("memory database"));
        let pinned = Provider::with_id(
            "desktop-id".to_string(),
            "Desktop".to_string(),
            json!({ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:1" } }),
            None,
        );
        db.save_provider("claude-desktop", &pinned)
            .expect("save desktop");
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/desktop-id/claude-desktop/v1/messages",
                proxy_info.port
            ))
            .header("authorization", "Bearer wrong-token")
            .json(&json!({
                "model": "claude-sonnet",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .expect("send desktop pin");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        proxy.stop().await.expect("stop test proxy");
    }

    #[tokio::test]
    async fn missing_pinned_id_is_not_found_and_is_not_forwarded() {
        let db = Arc::new(Database::memory().expect("memory database"));
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/missing-id/v1/messages",
                proxy_info.port
            ))
            .json(&json!({
                "model": "claude-sonnet",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .expect("send missing id");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value = response.json().await.expect("error json");
        assert_eq!(
            body,
            json!({
                "error": {
                    "message": "provider missing-id not found for claude",
                    "type": "proxy_error"
                }
            })
        );
        proxy.stop().await.expect("stop test proxy");
    }

    #[tokio::test]
    async fn pinned_claude_models_come_from_that_provider() {
        let db = Arc::new(Database::memory().expect("memory database"));
        let pinned = Provider::with_id(
            "pinned-id".to_string(),
            "Pinned".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_MODEL": "claude-main",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-mini",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Kimi K2",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-k2",
                    "ANTHROPIC_DEFAULT_FABLE_MODEL": "  "
                }
            }),
            None,
        );
        let empty = Provider::with_id(
            "empty-id".to_string(),
            "Empty".to_string(),
            json!({ "env": {} }),
            None,
        );
        let codex = Provider::with_id(
            "codex-id".to_string(),
            "Codex".to_string(),
            json!({ "auth": {} }),
            None,
        );
        db.save_provider("claude", &pinned).expect("save pinned");
        db.save_provider("claude", &empty).expect("save empty");
        db.save_provider("codex", &codex).expect("save codex");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let client = reqwest::Client::new();
        let listed = client
            .get(format!(
                "http://127.0.0.1:{}/pinned-id/v1/models?limit=1000",
                proxy_info.port
            ))
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .expect("pinned models");
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body: Value = listed.json().await.expect("models json");
        assert_eq!(
            listed_body,
            json!({
                "data": [
                    {
                        "type": "model",
                        "id": "claude-main",
                        "display_name": "claude-main",
                        "description": ""
                    },
                    {
                        "type": "model",
                        "id": "haiku-mini",
                        "display_name": "haiku-mini",
                        "description": ""
                    },
                    {
                        "type": "model",
                        "id": "kimi-k2",
                        "display_name": "Kimi K2",
                        "description": ""
                    }
                ],
                "has_more": false
            })
        );

        let empty_models = client
            .get(format!(
                "http://127.0.0.1:{}/empty-id/v1/models?limit=1000",
                proxy_info.port
            ))
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .expect("empty models");
        assert_eq!(empty_models.status(), StatusCode::OK);
        let empty_body: Value = empty_models.json().await.expect("empty json");
        assert_eq!(empty_body, json!({ "data": [], "has_more": false }));

        let catalog = client
            .get(format!(
                "http://127.0.0.1:{}/codex-id/v1/models",
                proxy_info.port
            ))
            .send()
            .await
            .expect("codex catalog");
        assert_eq!(catalog.status(), StatusCode::OK);
        let catalog_body: Value = catalog.json().await.expect("catalog json");
        assert!(
            catalog_body.get("models").is_some(),
            "codex pin should stay a catalog probe: {catalog_body}"
        );
        assert!(
            catalog_body.get("data").is_none(),
            "codex pin must not use the Claude model list: {catalog_body}"
        );

        proxy.stop().await.expect("stop test proxy");
    }

    #[tokio::test]
    async fn start_fails_when_listen_port_already_in_use_without_taking_the_port() {
        let occupant = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind occupant");
        let addr = occupant.local_addr().expect("occupant addr");

        let db = Arc::new(Database::memory().expect("memory database"));
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_address: "127.0.0.1".to_string(),
                listen_port: addr.port(),
                ..ProxyConfig::default()
            },
            db,
            None,
        );

        let err = proxy
            .start()
            .await
            .expect_err("start should fail when the port is taken");
        match err {
            ProxyError::BindFailed(msg) => {
                assert!(
                    msg.contains(&addr.port().to_string()),
                    "error should name the port: {msg}"
                );
                assert!(
                    msg.contains("already in use"),
                    "error should say the port is in use: {msg}"
                );
            }
            other => panic!("expected BindFailed, got {other:?}"),
        }

        tokio::net::TcpStream::connect(addr)
            .await
            .expect("occupant must keep the port");
    }
}
