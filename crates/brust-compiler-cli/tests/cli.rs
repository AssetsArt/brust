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
