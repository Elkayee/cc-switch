//! Peel `/{provider-id}/...` off a proxy path that matched no static route.
//!
//! Lookup and dispatch stay in the server fallback. This module only decides
//! whether the first segment is a candidate id and which app the remainder is.

use crate::app_config::AppType;

/// Why a path is not a pin, or the pin the fallback should look up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinClass {
    /// Reserved segment, bad percent-encoding, or a remainder that is not an app route.
    /// The fallback returns an empty 404 and does not query the database.
    NotAPin,
    Pin {
        id: String,
        app: AppType,
        /// Remainder the inner router should see, including the leading slash.
        path: String,
        query: Option<String>,
    },
}

/// Saved row selected by the path prefix. Handlers read this instead of In Use.
#[derive(Clone, Debug)]
pub struct PinnedProvider {
    pub provider: crate::provider::Provider,
}

pub fn pinned_provider(extensions: &http::Extensions) -> Option<crate::provider::Provider> {
    extensions
        .get::<PinnedProvider>()
        .map(|pin| pin.provider.clone())
}

/// Classify `path` (no query) plus an optional raw query string.
///
/// `claude_discovery` is the result of `is_claude_model_discovery`. It only
/// changes `/models` and `/v1/models`.
pub fn classify_provider_pin(path: &str, query: Option<&str>, claude_discovery: bool) -> PinClass {
    let Some((raw_id, remainder)) = split_first_segment(path) else {
        return PinClass::NotAPin;
    };
    let Some(id) = decode_segment(raw_id) else {
        return PinClass::NotAPin;
    };
    if RESERVED.contains(&id.as_str()) {
        return PinClass::NotAPin;
    }
    let path = format!("/{remainder}");
    let Some(app) = infer_app(&path, claude_discovery) else {
        return PinClass::NotAPin;
    };
    PinClass::Pin {
        id,
        app,
        path,
        query: query.map(str::to_string),
    }
}

const RESERVED: &[&str] = &[
    "v1",
    "health",
    "status",
    "claude",
    "claude-desktop",
    "codex",
    "gemini",
    "grokbuild",
    "models",
    "responses",
    "chat",
    "images",
    "alpha",
    "auth",
];

fn split_first_segment(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    Some(rest.split_once('/').unwrap_or((rest, "")))
}

fn decode_segment(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hi = from_hex(bytes[index + 1])?;
            let lo = from_hex(bytes[index + 2])?;
            out.push((hi << 4) | lo);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn infer_app(path: &str, claude_discovery: bool) -> Option<AppType> {
    if path == "/models" || path == "/v1/models" {
        return Some(if claude_discovery {
            AppType::Claude
        } else {
            AppType::Codex
        });
    }
    if is_gemini_route(path) {
        return Some(AppType::Gemini);
    }
    CODEX_ROUTES
        .iter()
        .find(|(route, _)| *route == path)
        .map(|(_, app)| app.clone())
        .or(match path {
            "/v1/messages" | "/claude/v1/messages" => Some(AppType::Claude),
            "/claude-desktop/v1/messages" | "/claude-desktop/v1/models" => {
                Some(AppType::ClaudeDesktop)
            }
            "/grokbuild/v1/responses" | "/grokbuild/v1/responses/compact" => {
                Some(AppType::GrokBuild)
            }
            _ => None,
        })
}

fn is_gemini_route(path: &str) -> bool {
    const PREFIXES: [&str; 3] = ["/v1beta/", "/gemini/v1beta/", "/gemini/v1/"];
    PREFIXES.iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|capture| !capture.is_empty())
    })
}

const CODEX_ROUTES: &[(&str, AppType)] = &[
    ("/chat/completions", AppType::Codex),
    ("/v1/chat/completions", AppType::Codex),
    ("/v1/v1/chat/completions", AppType::Codex),
    ("/codex/v1/chat/completions", AppType::Codex),
    ("/responses", AppType::Codex),
    ("/v1/responses", AppType::Codex),
    ("/v1/v1/responses", AppType::Codex),
    ("/codex/v1/responses", AppType::Codex),
    ("/responses/compact", AppType::Codex),
    ("/v1/responses/compact", AppType::Codex),
    ("/v1/v1/responses/compact", AppType::Codex),
    ("/codex/v1/responses/compact", AppType::Codex),
    ("/alpha/search", AppType::Codex),
    ("/v1/alpha/search", AppType::Codex),
    ("/v1/v1/alpha/search", AppType::Codex),
    ("/codex/v1/alpha/search", AppType::Codex),
    ("/images/generations", AppType::Codex),
    ("/v1/images/generations", AppType::Codex),
    ("/v1/v1/images/generations", AppType::Codex),
    ("/codex/v1/images/generations", AppType::Codex),
    ("/images/edits", AppType::Codex),
    ("/v1/images/edits", AppType::Codex),
    ("/v1/v1/images/edits", AppType::Codex),
    ("/codex/v1/images/edits", AppType::Codex),
];
#[cfg(test)]
mod tests {
    use super::*;

    fn pin<'a>(
        path: &'a str,
        query: Option<&'a str>,
        discovery: bool,
    ) -> (String, AppType, String, Option<String>) {
        match classify_provider_pin(path, query, discovery) {
            PinClass::Pin {
                id,
                app,
                path,
                query,
            } => (id, app, path, query),
            PinClass::NotAPin => panic!("expected a pin for {path}"),
        }
    }

    #[test]
    fn claude_messages_under_id_rewrites_to_v1_messages() {
        // Break: peeling the id off the wrong side, or tagging the remainder Codex.
        let (id, app, path, query) = pin("/prov-1/v1/messages", None, false);
        assert_eq!(id, "prov-1");
        assert_eq!(app, AppType::Claude);
        assert_eq!(path, "/v1/messages");
        assert_eq!(query, None);
    }

    #[test]
    fn query_string_is_kept_verbatim() {
        // Break: dropping or re-encoding the query during the rewrite.
        let (_, _, path, query) = pin("/prov-1/v1/models", Some("beta=true"), true);
        assert_eq!(path, "/v1/models");
        assert_eq!(query.as_deref(), Some("beta=true"));
    }

    #[test]
    fn encoded_slash_stays_inside_the_id() {
        // Break: percent-decoding the whole path before the split, so `%2F` becomes a segment.
        let (id, app, path, _) = pin("/a%2Fb/v1/messages", None, false);
        assert_eq!(id, "a/b");
        assert_eq!(app, AppType::Claude);
        assert_eq!(path, "/v1/messages");
    }

    #[test]
    fn bad_percent_encoding_is_not_a_pin() {
        // Break: accepting `%ZZ` or a trailing `%` as an id, or panicking on it.
        assert_eq!(
            classify_provider_pin("/a%ZZ/v1/messages", None, false),
            PinClass::NotAPin
        );
        assert_eq!(
            classify_provider_pin("/abc%/v1/messages", None, false),
            PinClass::NotAPin
        );
    }

    #[test]
    fn reserved_first_segment_is_not_a_pin() {
        // Break: treating a static prefix (`v1`, `claude`, `responses`) as a provider id.
        for path in [
            "/v1/not-a-route",
            "/health/v1/messages",
            "/claude/v1/messages",
            "/responses/extra",
            "/alpha/search",
        ] {
            assert_eq!(
                classify_provider_pin(path, None, false),
                PinClass::NotAPin,
                "{path}"
            );
        }
    }

    #[test]
    fn unknown_remainder_is_not_a_pin() {
        // Break: forwarding any remainder once the first segment is not reserved.
        assert_eq!(
            classify_provider_pin("/prov-1/v1/nope", None, false),
            PinClass::NotAPin
        );
        assert_eq!(
            classify_provider_pin("/prov-1", None, false),
            PinClass::NotAPin
        );
    }

    #[test]
    fn codex_gemini_and_grok_remainders_keep_their_app() {
        // Break: collapsing every recognized remainder onto Claude.
        let cases = [
            ("/pid/v1/responses", AppType::Codex, "/v1/responses"),
            ("/pid/v1/v1/responses", AppType::Codex, "/v1/v1/responses"),
            ("/pid/responses", AppType::Codex, "/responses"),
            (
                "/pid/codex/v1/alpha/search",
                AppType::Codex,
                "/codex/v1/alpha/search",
            ),
            ("/pid/images/edits", AppType::Codex, "/images/edits"),
            (
                "/pid/v1beta/models/gemini-2.5-pro:generateContent",
                AppType::Gemini,
                "/v1beta/models/gemini-2.5-pro:generateContent",
            ),
            (
                "/pid/gemini/v1/models/x",
                AppType::Gemini,
                "/gemini/v1/models/x",
            ),
            (
                "/pid/grokbuild/v1/responses",
                AppType::GrokBuild,
                "/grokbuild/v1/responses",
            ),
            (
                "/pid/grokbuild/v1/responses/compact",
                AppType::GrokBuild,
                "/grokbuild/v1/responses/compact",
            ),
            (
                "/pid/claude-desktop/v1/messages",
                AppType::ClaudeDesktop,
                "/claude-desktop/v1/messages",
            ),
            (
                "/pid/claude-desktop/v1/models",
                AppType::ClaudeDesktop,
                "/claude-desktop/v1/models",
            ),
            (
                "/pid/claude/v1/messages",
                AppType::Claude,
                "/claude/v1/messages",
            ),
            ("/pid/chat/completions", AppType::Codex, "/chat/completions"),
            (
                "/pid/v1/chat/completions",
                AppType::Codex,
                "/v1/chat/completions",
            ),
            (
                "/pid/codex/v1/responses",
                AppType::Codex,
                "/codex/v1/responses",
            ),
            (
                "/pid/v1/responses/compact",
                AppType::Codex,
                "/v1/responses/compact",
            ),
            ("/pid/alpha/search", AppType::Codex, "/alpha/search"),
            (
                "/pid/images/generations",
                AppType::Codex,
                "/images/generations",
            ),
            (
                "/pid/gemini/v1beta/models/x",
                AppType::Gemini,
                "/gemini/v1beta/models/x",
            ),
        ];
        for (input, app, path) in cases {
            let got = pin(input, None, false);
            assert_eq!(got.0, "pid", "{input}");
            assert_eq!(got.1, app, "{input}");
            assert_eq!(got.2, path, "{input}");
        }
    }

    #[test]
    fn models_remainder_follows_the_discovery_flag() {
        // Break: always treating `/v1/models` as Codex, so a Claude id 404s.
        let claude = pin("/pid/v1/models", None, true);
        assert_eq!(claude.1, AppType::Claude);
        assert_eq!(claude.2, "/v1/models");
        let codex = pin("/pid/models", None, false);
        assert_eq!(codex.1, AppType::Codex);
        assert_eq!(codex.2, "/models");
    }

    #[test]
    fn gemini_prefix_without_a_capture_is_not_a_pin() {
        // Break: treating bare `/v1beta` as the wildcard route axum does not register.
        assert_eq!(
            classify_provider_pin("/pid/v1beta", None, false),
            PinClass::NotAPin
        );
    }
}
