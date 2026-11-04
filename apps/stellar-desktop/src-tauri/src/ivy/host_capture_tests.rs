use super::tests::fixture;
use super::*;
#[cfg(windows)]
#[test]
fn early_window_capture_uses_private_binary_reply_during_admission() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let (host, _receiver) = fixture();
    let host = Arc::new(host);
    host.shared.update(0, |view| {
        view.connection = IvyConnectionState::Ready;
        view.turn = IvyTurnState::Submitting;
        view.turn_id = Some("00000000-0000-4000-8000-000000000001".into());
    });
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    super::super::workspace_data::configure(
        json!({
            "descriptor":{"port":12345,"credential_ref":"0123456789abcdef0123456789abcdef"},
            "image_port":listener.local_addr().unwrap().port(),"image_secret":"a".repeat(64)
        }),
        &host.workspace.image_endpoint(),
    )
    .unwrap();
    let script = r#"
$null=[Console]::ReadLine()
[Console]::WriteLine('{"event":"workspace_tool","data":{"version":1,"request_id":"0123456789abcdef0123456789abcdef","issued_at_ms":"1700000000000","epoch":"0","turn_id":"00000000-0000-4000-8000-000000000001","operation":{"kind":"capture_window"}}}'.Replace('1700000000000', [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
$reply=[Console]::ReadLine() | ConvertFrom-Json
if ($reply.control -eq 'test_ack') { [Console]::WriteLine('{"id":1,"result":{"captured":true}}') }
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut broker = Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap();
    host.workspace.set_input(Some(broker.input()));
    host.set_workspace_capture(Arc::new(|operation| {
        assert!(matches!(
            operation,
            super::super::workspace_contracts::WorkspaceToolOperation::CaptureWindow
        ));
        Ok(super::super::workspace_capture::Captured::Image(
            b"\x89PNG\r\n\x1a\nx".to_vec(),
        ))
    }));
    let control = broker.input();
    let image_receiver = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let header: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(header["secret"], "a".repeat(64));
        assert_eq!(header["size"], 9);
        let mut image = [0; 9];
        reader.read_exact(&mut image).unwrap();
        assert_eq!(&image, b"\x89PNG\r\n\x1a\nx");
        reader.get_mut().write_all(&[1]).unwrap();
        super::super::process::control(&control, &json!({"control":"test_ack"})).unwrap();
    });
    let hub = host.workspace.clone();
    broker.set_workspace(
        Arc::new(move |frame| hub.handle(frame)),
        host.workspace.image_endpoint(),
    );
    assert_eq!(
        broker
            .call("prompt.submit", json!({}), &mut vec![])
            .unwrap(),
        json!({"captured":true})
    );
    image_receiver.join().unwrap();
}
