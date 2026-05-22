use std::io::{BufRead, BufReader};
use std::process::{ChildStdout, Command, Stdio};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_rendered_html() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_brust"))
        .env("BRUST_PORT", "38123")
        .env("RUST_LOG", "brust=info")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn brust");

    let port = read_port_line(child.stdout.take().expect("stdout piped"))
        .expect("did not see listening line");

    tokio::time::sleep(Duration::from_millis(200)).await;

    let resp = reqwest::get(format!("http://127.0.0.1:{port}/"))
        .await
        .expect("GET /");
    assert_eq!(resp.status(), 200);

    let body = resp.text().await.expect("body");
    assert!(body.contains("Hello from Brust"), "body did not contain expected text: {body}");
    assert!(body.contains("worker_id="), "body did not contain worker_id: {body}");

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .expect("sigint");

    let status = tokio::task::spawn_blocking(move || child.wait())
        .await
        .expect("join wait")
        .expect("child wait");
    assert!(status.success(), "brust exited non-zero: {status:?}");
}

fn read_port_line(stdout: ChildStdout) -> Option<u16> {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.ok()?;
        if let Some(rest) = line.split("listening on 127.0.0.1:").nth(1) {
            let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(port) = port_str.parse::<u16>() {
                return Some(port);
            }
        }
    }
    None
}
