//! Headless server binary: serves CC Switch's UI in a browser instead of a
//! native window.
//!
//! All logic lives in `cc_switch_lib::server` so that `generate_handler!` runs
//! inside the library, next to the commands whose wrapper macros it expands to.

fn main() {
    cc_switch_lib::server::runtime::main();
}
