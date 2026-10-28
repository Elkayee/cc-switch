use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("Upstream response body exceeds size limit: {0} bytes")]
    ResponseBodyTooLarge(usize),

    #[error("Server is already running")]
    AlreadyRunning,

    #[error("Server is not running")]
    NotRunning,

    #[error("Failed to bind address: {0}")]
    BindFailed(String),

    #[error("Stop timed out")]
    StopTimeout,

    #[error("Stop failed: {0}")]
    StopFailed(String),

    #[error("Request forward failed: {0}")]
    ForwardFailed(String),

    #[error("No available provider")]
    NoAvailableProvider,

    #[error("All providers are circuit-open; no channel available")]
    AllProvidersCircuitOpen,

    #[error("No providers configured")]
    NoProvidersConfigured,

    #[allow(dead_code)]
    #[error("Provider unhealthy: {0}")]
    ProviderUnhealthy(String),

    #[error("Upstream error (status {status}): {body:?}")]
    UpstreamError { status: u16, body: Option<String> },

    #[error("Max retries exceeded")]
    MaxRetriesExceeded,

    #[error("Database error: {0}")]
    DatabaseError(String),

    #[error("Config error: {0}")]
    ConfigError(String),

    #[allow(dead_code)]
    #[error("Transform error: {0}")]
    TransformError(String),

    #[allow(dead_code)]
    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    /// 流式响应空闲超时
    #[allow(dead_code)]
    #[error("Stream idle timeout: no data for {0}s")]
    StreamIdleTimeout(u64),

    /// 认证错误
    #[error("Authentication failed: {0}")]
    AuthError(String),

    #[allow(dead_code)]
    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            ProxyError::UpstreamError {
                status: upstream_status,
                body: upstream_body,
            } => {
                let http_status =
                    StatusCode::from_u16(*upstream_status).unwrap_or(StatusCode::BAD_GATEWAY);

                // 尝试解析上游响应体为 JSON，如果失败则包装为字符串
                let error_body = if let Some(body_str) = upstream_body {
                    if let Ok(json_body) = serde_json::from_str::<serde_json::Value>(body_str) {
                        // 上游返回的是 JSON，直接透传
                        json_body
                    } else {
                        // 上游返回的不是 JSON，包装为错误消息
                        json!({
                            "error": {
                                "message": body_str,
                                "type": "upstream_error",
                            }
                        })
                    }
                } else {
                    json!({
                        "error": {
                            "message": format!("Upstream error (status {})", upstream_status),
                            "type": "upstream_error",
                        }
                    })
                };

                (http_status, error_body)
            }
            _ => {
                let (http_status, message) = match &self {
                    ProxyError::AlreadyRunning => (StatusCode::CONFLICT, self.to_string()),
                    ProxyError::NotRunning => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
                    ProxyError::BindFailed(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::StopTimeout => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::StopFailed(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::ForwardFailed(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
                    ProxyError::NoAvailableProvider => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::AllProvidersCircuitOpen => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::NoProvidersConfigured => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::ProviderUnhealthy(_) => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::MaxRetriesExceeded => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::DatabaseError(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::ConfigError(_) => (StatusCode::BAD_REQUEST, self.to_string()),
                    ProxyError::TransformError(_) => {
                        (StatusCode::UNPROCESSABLE_ENTITY, self.to_string())
                    }
                    ProxyError::InvalidRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
                    ProxyError::Timeout(_) => (StatusCode::GATEWAY_TIMEOUT, self.to_string()),
                    ProxyError::StreamIdleTimeout(_) => {
                        (StatusCode::GATEWAY_TIMEOUT, self.to_string())
                    }
                    ProxyError::AuthError(_) => (StatusCode::UNAUTHORIZED, self.to_string()),
                    ProxyError::Internal(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::ResponseBodyTooLarge(_) => {
                        (StatusCode::BAD_GATEWAY, self.to_string())
                    }
                    ProxyError::UpstreamError { .. } => unreachable!(),
                };

                let error_body = json!({
                    "error": {
                        "message": message,
                        "type": "proxy_error",
                    }
                });

                (http_status, error_body)
            }
        };

        (status, Json(body)).into_response()
    }
}

/// 错误分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// 可重试错误（网络问题、5xx）
    Retryable, // 网络超时、5xx 错误
    /// 不可重试错误（4xx、认证失败）
    NonRetryable, // 认证失败、参数错误、4xx 错误
    #[allow(dead_code)]
    ClientAbort, // 客户端主动中断
}

/// 把错误连同 `source()` 原因链拼成一行。
///
/// reqwest / hyper 的外层文本只有「error sending request」「error decoding response body」
/// 这类描述，真正能区分 DNS、TCP、TLS、连接被重置的信息都在原因链里。
pub fn describe_error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        // 有的错误会把原因也写进自己的文本，重复的就不再追加
        if !cause_text.is_empty() && !text.ends_with(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// reqwest 错误的文本带完整 URL（查询参数里可能有 Key），先去掉 URL 再展开原因链。
pub fn describe_reqwest_error(error: reqwest::Error) -> String {
    describe_error_chain(&error.without_url())
}

/// 判断错误是否可重试
#[allow(dead_code)]
pub fn categorize_error(error: &reqwest::Error) -> ErrorCategory {
    if error.is_timeout() || error.is_connect() {
        return ErrorCategory::Retryable;
    }

    if let Some(status) = error.status() {
        if status.is_server_error() {
            ErrorCategory::Retryable
        } else if status.is_client_error() {
            ErrorCategory::NonRetryable
        } else {
            ErrorCategory::Retryable
        }
    } else {
        ErrorCategory::Retryable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Outer(std::io::Error);

    impl std::fmt::Display for Outer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("error sending request")
        }
    }

    impl std::error::Error for Outer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn describe_error_chain_appends_every_cause() {
        let error = Outer(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "tcp connect error",
        ));
        assert_eq!(
            describe_error_chain(&error),
            "error sending request: tcp connect error"
        );
    }

    #[tokio::test]
    async fn describe_reqwest_error_keeps_cause_and_drops_url() {
        // 先占一个端口再释放，保证连接被拒绝
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let error = reqwest::Client::new()
            .get(format!(
                "http://127.0.0.1:{port}/v1/responses?key=secret-token"
            ))
            .send()
            .await
            .expect_err("connection should be refused");
        assert!(error.is_connect());

        let text = describe_reqwest_error(error);
        assert!(text.starts_with("error sending request: "), "{text}");
        assert!(!text.contains("secret-token"), "{text}");
    }
}
