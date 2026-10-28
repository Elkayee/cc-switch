//! Guards the duplicated command list in `server/handler.rs` against drifting
//! from `lib.rs`'s.
//!
//! Browser mode registers its own `generate_handler!` list rather than sharing
//! `run()`'s, to avoid editing the block upstream touches on every new command
//! (see `server/handler.rs`). The cost is that a command added to `lib.rs`
//! alone is silently unreachable over HTTP: it still compiles, and the missing
//! name only shows up as a "not found" error at runtime.
//!
//! This test closes that hole by parsing both lists out of the sources and
//! asserting set equality. It caught `update_tray_menu` missing from the
//! initial implementation.
//!
//! Runs under default features too — it is pure text analysis and does not need
//! the `server-runtime` runtime.

const LIB_SOURCE: &str = include_str!("../src/lib.rs");
const HANDLER_SOURCE: &str = include_str!("../src/server/handler.rs");

/// Returns the text between the `[` and its matching `]` after `needle`.
///
/// Bracket-matched rather than scanning for the first `]`, so a nested `[...]`
/// (an attribute, an array literal) cannot truncate the capture and make the
/// test pass by reading a short list.
fn extract_macro_block(source: &str, needle: &str) -> String {
    // Search from the *end* of the needle: a needle may itself contain a `[`
    // (e.g. the `&[&str]` in a const's type annotation), and starting the scan
    // at the needle's beginning would capture that instead of the real body.
    let start = source
        .find(needle)
        .map(|at| at + needle.len())
        .unwrap_or_else(|| panic!("could not find `{needle}` — did the call site change?"));
    let open = source[start..]
        .find('[')
        .map(|offset| start + offset)
        .expect("no `[` after the needle");

    let mut depth = 0usize;
    for (index, ch) in source[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return source[open + 1..open + index].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced brackets in the `{needle}` block");
}

/// Pulls the bare command names out of a `generate_handler!` block body.
fn parse_command_names(block: &str) -> Vec<String> {
    let mut names = Vec::new();

    for raw_line in block.lines() {
        // Strip line comments; the lists are heavily commented by section.
        let line = match raw_line.find("//") {
            Some(at) => &raw_line[..at],
            None => raw_line,
        };

        for token in line.split(',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            // `commands::get_providers` / `crate::update_tray_menu` -> last segment.
            let name = token.rsplit("::").next().unwrap_or(token);
            let is_identifier = !name.is_empty()
                && name
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if is_identifier {
                names.push(name.to_string());
            }
        }
    }

    names
}

fn lib_commands() -> Vec<String> {
    parse_command_names(&extract_macro_block(
        LIB_SOURCE,
        ".invoke_handler(tauri::generate_handler!",
    ))
}

fn handler_commands() -> Vec<String> {
    parse_command_names(&extract_macro_block(
        HANDLER_SOURCE,
        "tauri::generate_handler!",
    ))
}

/// Sanity check on the parser itself: if a source refactor broke extraction,
/// every other assertion here would pass trivially on two empty sets.
#[test]
fn parser_finds_a_plausible_number_of_commands() {
    let lib = lib_commands();
    let handler = handler_commands();

    assert!(
        lib.len() > 250,
        "parsed only {} commands from lib.rs — the parser is probably broken",
        lib.len()
    );
    assert!(
        handler.len() > 250,
        "parsed only {} commands from server/handler.rs — the parser is probably broken",
        handler.len()
    );

    // A known-present entry from each end of lib.rs's list, to catch a capture
    // that starts or stops in the wrong place.
    assert!(lib.contains(&"get_providers".to_string()));
    assert!(lib.contains(&"is_lightweight_mode".to_string()));
}

#[test]
fn neither_list_repeats_a_command() {
    for (label, commands) in [
        ("lib.rs", lib_commands()),
        ("handler.rs", handler_commands()),
    ] {
        let mut sorted = commands.clone();
        sorted.sort();
        let total = sorted.len();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            total,
            "{label} registers the same command more than once"
        );
    }
}

/// The actual guard.
#[test]
fn browser_mode_registers_every_desktop_command() {
    let lib = lib_commands();
    let handler = handler_commands();

    let lib_set: std::collections::BTreeSet<_> = lib.iter().collect();
    let handler_set: std::collections::BTreeSet<_> = handler.iter().collect();

    let missing: Vec<_> = lib_set.difference(&handler_set).collect();
    let extra: Vec<_> = handler_set.difference(&lib_set).collect();

    assert!(
        missing.is_empty(),
        "these commands are registered in lib.rs but NOT in server/handler.rs, so they are \
         unreachable in browser mode — add them to `server::handler::invoke_handler`: {missing:?}"
    );
    assert!(
        extra.is_empty(),
        "these commands are registered in server/handler.rs but not in lib.rs — they were \
         probably renamed or removed upstream: {extra:?}"
    );
}

/// Everything the bridge refuses by name must actually be a registered command.
/// A typo there would silently stop refusing, letting a native-only command
/// through to fail with a confusing error instead of the intended 501.
#[test]
fn native_only_exclusions_name_real_commands() {
    let handler = handler_commands();
    // Anchored past the type annotation: `&[&str]` contains a `[` of its own,
    // and capturing from there would read the type instead of the array.
    let block = extract_macro_block(
        include_str!("../src/server/bridge.rs"),
        "NATIVE_ONLY_COMMANDS: &[&str] = &",
    );

    let mut excluded = Vec::new();
    for raw_line in block.lines() {
        let line = match raw_line.find("//") {
            Some(at) => &raw_line[..at],
            None => raw_line,
        };
        for token in line.split(',') {
            let token = token.trim().trim_matches('"');
            if !token.is_empty() {
                excluded.push(token.to_string());
            }
        }
    }

    assert!(
        !excluded.is_empty(),
        "parsed no entries from NATIVE_ONLY_COMMANDS — the parser is probably broken"
    );

    for name in &excluded {
        assert!(
            handler.contains(name),
            "`{name}` is in NATIVE_ONLY_COMMANDS but is not a registered command — \
             renamed or misspelled?"
        );
    }
}
