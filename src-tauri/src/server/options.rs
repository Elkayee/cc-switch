//! CLI options for the headless server.
//!
//! Hand-parsed rather than pulling in a CLI crate: the surface is four flags,
//! and adding a dependency to the desktop app's manifest for the sake of the
//! server binary is not worth it.

use std::net::{IpAddr, Ipv4Addr};

pub const DEFAULT_PORT: u16 = 0;
pub const DEFAULT_HOST: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

pub const HELP: &str = "\
cli-switch — Cli-Switch in your browser

USAGE:
    cli-switch [OPTIONS]

OPTIONS:
    -p, --port <PORT>    Port to listen on (default: an OS-assigned free port)
        --host <HOST>    Address to bind (default: 127.0.0.1). Binding a
                         non-loopback address exposes the API to your network.
        --no-open        Do not open a browser automatically
        --token <TOKEN>  Require this value as a bearer token on /api/*.
                         Unset by default: with no token, anyone who can reach
                         the port can read and change your provider
                         configuration, including API keys.
    -h, --help           Print this help
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerOptions {
    pub host: IpAddr,
    pub port: u16,
    pub open: bool,
    pub token: Option<String>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST,
            port: DEFAULT_PORT,
            open: true,
            token: None,
        }
    }
}

/// What `main` should do after parsing.
#[derive(Debug, PartialEq, Eq)]
pub enum ParseOutcome {
    Run(ServerOptions),
    Help,
}

pub fn parse<I, S>(args: I) -> Result<ParseOutcome, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut options = ServerOptions::default();
    let mut args = args.into_iter().map(|a| a.as_ref().to_string());

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(ParseOutcome::Help),
            "--no-open" => options.open = false,
            "--token" => {
                let raw = args
                    .next()
                    .ok_or_else(|| format!("{arg} requires a value"))?;
                options.token = Some(parse_token(&raw)?);
            }
            "-p" | "--port" => {
                let raw = args
                    .next()
                    .ok_or_else(|| format!("{arg} requires a value"))?;
                options.port = parse_port(&raw)?;
            }
            "--host" => {
                let raw = args
                    .next()
                    .ok_or_else(|| format!("{arg} requires a value"))?;
                options.host = parse_host(&raw)?;
            }
            other => {
                // Support `--flag=value` as well as `--flag value`.
                if let Some(raw) = other.strip_prefix("--port=") {
                    options.port = parse_port(raw)?;
                } else if let Some(raw) = other.strip_prefix("--host=") {
                    options.host = parse_host(raw)?;
                } else if let Some(raw) = other.strip_prefix("--token=") {
                    options.token = Some(parse_token(raw)?);
                } else {
                    return Err(format!("unrecognized argument `{other}`"));
                }
            }
        }
    }

    Ok(ParseOutcome::Run(options))
}

fn parse_port(raw: &str) -> Result<u16, String> {
    raw.parse::<u16>()
        .map_err(|_| format!("invalid port `{raw}` (expected 0-65535)"))
}

fn parse_token(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("--token requires a non-empty value".to_string());
    }
    Ok(raw.to_string())
}

fn parse_host(raw: &str) -> Result<IpAddr, String> {
    match raw {
        // Convenience aliases; `localhost` is not parseable as an IpAddr.
        "localhost" => Ok(DEFAULT_HOST),
        "any" => Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        _ => raw
            .parse::<IpAddr>()
            .map_err(|_| format!("invalid host `{raw}` (expected an IP address)")),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, ParseOutcome, ServerOptions, DEFAULT_HOST, DEFAULT_PORT, HELP};
    use std::net::{IpAddr, Ipv4Addr};

    fn run(args: &[&str]) -> ServerOptions {
        match parse(args).unwrap() {
            ParseOutcome::Run(options) => options,
            ParseOutcome::Help => panic!("expected Run, got Help"),
        }
    }

    #[test]
    fn defaults_to_loopback_and_ephemeral_port() {
        let options = run(&[]);
        assert_eq!(options.host, DEFAULT_HOST);
        assert_eq!(options.port, DEFAULT_PORT);
        assert!(options.open);
    }

    #[test]
    fn parses_port_in_both_forms() {
        assert_eq!(run(&["--port", "8080"]).port, 8080);
        assert_eq!(run(&["--port=8080"]).port, 8080);
        assert_eq!(run(&["-p", "8080"]).port, 8080);
    }

    #[test]
    fn parses_host_in_both_forms() {
        let expected = IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0));
        assert_eq!(run(&["--host", "0.0.0.0"]).host, expected);
        assert_eq!(run(&["--host=0.0.0.0"]).host, expected);
        assert_eq!(run(&["--host", "any"]).host, expected);
        assert_eq!(run(&["--host", "localhost"]).host, DEFAULT_HOST);
    }

    #[test]
    fn no_open_disables_browser_launch() {
        assert!(!run(&["--no-open"]).open);
    }

    #[test]
    fn no_token_by_default() {
        assert_eq!(run(&[]).token, None);
    }

    #[test]
    fn parses_token_in_both_forms() {
        assert_eq!(run(&["--token", "s3cret"]).token.as_deref(), Some("s3cret"));
        assert_eq!(run(&["--token=s3cret"]).token.as_deref(), Some("s3cret"));
    }

    /// `--token ""` would otherwise turn the check on while accepting an empty
    /// bearer value, which is worse than either intent.
    #[test]
    fn rejects_an_empty_token() {
        assert!(parse(["--token", ""]).is_err());
        assert!(parse(["--token="]).is_err());
        assert!(parse(["--token", "   "]).is_err());
        assert!(parse(["--token"]).is_err());
    }

    #[test]
    fn token_is_documented_in_help() {
        assert!(HELP.contains("--token"));
    }

    #[test]
    fn help_short_circuits() {
        assert_eq!(parse(["--help"]).unwrap(), ParseOutcome::Help);
        assert_eq!(parse(["-h"]).unwrap(), ParseOutcome::Help);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(["--port", "70000"]).is_err());
        assert!(parse(["--port", "abc"]).is_err());
        assert!(parse(["--port"]).is_err());
        assert!(parse(["--host", "not-an-ip"]).is_err());
        assert!(parse(["--host"]).is_err());
        assert!(parse(["--nope"]).is_err());
    }
}
