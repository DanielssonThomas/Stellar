mod contracts;
mod validate;

use contracts::{TelemetryError, TelemetrySnapshot};
use std::time::Duration;

const URL: &str = "http://127.0.0.1:4212/api/live";
const MAX_BODY: usize = 256 * 1024;

async fn fetch(url: &str) -> Result<TelemetrySnapshot, TelemetryError> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|_| TelemetryError::Unavailable)?;
    let mut response = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            TelemetryError::Timeout
        } else {
            TelemetryError::Unavailable
        }
    })?;
    if !response.status().is_success()
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.split(';').next() == Some("application/json"))
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(TelemetryError::Invalid);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        if e.is_timeout() {
            TelemetryError::Timeout
        } else {
            TelemetryError::Unavailable
        }
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_BODY {
            return Err(TelemetryError::Invalid);
        }
        body.extend_from_slice(&chunk);
    }
    let snapshot =
        serde_json::from_slice::<TelemetrySnapshot>(&body).map_err(|_| TelemetryError::Invalid)?;
    if !validate::validate(&snapshot) {
        return Err(TelemetryError::Invalid);
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn telemetry_snapshot(
    window: tauri::WebviewWindow,
) -> Result<TelemetrySnapshot, TelemetryError> {
    if window.label() != "main" {
        return Err(TelemetryError::Unavailable);
    }
    fetch(URL).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn fixture() -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"sequence":2,"observedAt":"2026-11-02T12:00:00.000Z","agents":[{"id":"architect","name":"Architect","project":"stellar","state":"running","sessionId":"abcdef0123456789","task":null,"activity":"Processing a turn","tool":null,"model":null,"provider":null,"usage":null,"startedAt":null,"lastObservedAt":null,"source":{"kind":"hermes-turn-lease","health":"available","observedAt":"2026-11-02T12:00:00.000Z"},"events":[]}]})
    }
    fn server(status: &str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut input = [0; 2048];
            let n = stream.read(&mut input).unwrap();
            assert!(String::from_utf8_lossy(&input[..n]).starts_with("GET /api/live HTTP/1.1"));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://127.0.0.1:{port}/api/live")
    }
    #[test]
    fn accepts_valid_source_and_rejects_nested_unknowns_and_redirects() {
        let mut bad = fixture();
        bad["agents"][0]["source"]["private"] = "secret".into();
        for (status, body, valid) in [
            ("200 OK", fixture().to_string(), true),
            ("200 OK", bad.to_string(), false),
            ("302 Found", fixture().to_string(), false),
            ("200 OK", "x".repeat(MAX_BODY + 1), false),
        ] {
            let url = server(status, body);
            assert_eq!(tauri::async_runtime::block_on(fetch(&url)).is_ok(), valid);
        }
    }
    #[test]
    fn rejects_private_task_and_invalid_nested_values() {
        let mut missing = fixture();
        missing["agents"][0].as_object_mut().unwrap().remove("task");
        assert!(serde_json::from_value::<TelemetrySnapshot>(missing).is_err());
        for (key, value) in [
            ("task", serde_json::json!("private task")),
            ("activity", serde_json::json!("raw prompt")),
            ("sessionId", serde_json::json!("private-session")),
            ("name", serde_json::json!("private name")),
        ] {
            let mut raw = fixture();
            raw["agents"][0][key] = value;
            let snapshot: TelemetrySnapshot = serde_json::from_value(raw).unwrap();
            assert!(!validate::validate(&snapshot));
        }
    }

    #[test]
    fn an_unresponsive_local_source_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_secs(5));
        });
        let result =
            tauri::async_runtime::block_on(fetch(&format!("http://127.0.0.1:{port}/api/live")));
        assert!(matches!(result, Err(TelemetryError::Timeout)));
        server.join().unwrap();
    }
}
