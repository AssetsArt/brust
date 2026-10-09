use std::process::Command;

fn brustc() -> Command {
    Command::new(env!("CARGO_BIN_EXE_brustc"))
}

fn fixture(name: &str) -> String {
    format!(
        "{}/../../tests/fixtures/{name}/input.tsx",
        env!("CARGO_MANIFEST_DIR")
    )
}

#[test]
fn emit_parse_prints_json() {
    let out = brustc()
        .arg(fixture("theme-toggle"))
        .args(["--emit", "parse"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["default_export_function"], "ThemeToggle");
    assert_eq!(v["imports"], serde_json::json!(["react"]));
}

#[test]
fn parse_error_exits_1_with_position() {
    let dir = std::env::temp_dir().join("brustc-bad");
    std::fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.tsx");
    std::fs::write(&bad, "export default function X() { return <div> }").unwrap();
    let out = brustc()
        .arg(&bad)
        .args(["--emit", "parse"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("error: "), "{err}");
    assert!(err.contains("bad.tsx:1:"), "{err}");
}

#[test]
fn bad_usage_exits_2() {
    let out = brustc().output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn emit_ir_prints_component_ir() {
    let out = brustc()
        .arg(fixture("theme-toggle"))
        .args(["--emit", "ir"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["tier"], "Native");
    assert_eq!(v["needs_worker"], false);
    assert_eq!(v["state"][0]["name"], "mode");
    assert_eq!(v["template"]["Element"]["tag"], "button");
}

#[test]
fn emit_diag_exits_1_on_error_and_0_otherwise() {
    let out = brustc()
        .arg(fixture("missing-key"))
        .args(["--emit", "diag"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.starts_with("error list-key "), "{text}");
    assert!(text.contains("input.tsx:5:9 "), "{text}");

    let out = brustc()
        .arg(fixture("fragment-root"))
        .args(["--emit", "diag"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("warning fragment-root "));
}

/// M1b-2 acceptance: a server-only import reached from a handler fails the build,
/// and a child component resolves relative to the input file.
#[test]
fn server_leak_diag_exits_1_and_children_resolve() {
    let out = brustc()
        .arg(fixture("server-leak"))
        .args(["--emit", "diag"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.starts_with("error server-only-in-client "), "{text}");

    let out = brustc()
        .arg(fixture("parent-counter"))
        .args(["--emit", "ir"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["children"][0]["tier"], "Native");
    assert_eq!(v["child_links"][0]["props_member"], "_p1");
}

#[test]
fn unknown_emit_exits_2() {
    let out = brustc()
        .arg(fixture("theme-toggle"))
        .args(["--emit", "template"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}
