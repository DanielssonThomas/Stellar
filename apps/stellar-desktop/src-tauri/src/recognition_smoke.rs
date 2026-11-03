//! Explicit test build: fixed synthetic PCM, restricted IPC, no debug listener.
use serde::{Deserialize, Serialize};
use std::io::Read;
use tauri::{Manager, Webview, Wry};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Measurement {
    stage: Stage,
    started_at_unix_ms: u64,
    milliseconds: f64,
    frame_count: u32,
    frame_p50_ms: Option<f64>,
    frame_p95_ms: Option<f64>,
    frame_max_ms: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    IdleCold,
    KeywordsCold,
    KeywordsWarm,
    TranscriberCold,
    TranscriberWarm,
    IdleWarm,
    Cancellation,
    Recovery,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    wake: Vec<i16>,
    long: Vec<i16>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Report {
    success: bool,
    visible: bool,
    wake: bool,
    cancelled: bool,
    stale_epoch_rejected: bool,
    recovered: bool,
    measurements: Vec<Measurement>,
}

#[tauri::command]
fn recognition_result(app: tauri::AppHandle, report: Report) {
    let bounded = report.measurements.len() <= 10
        && report.measurements.iter().all(|item| {
            item.milliseconds.is_finite()
                && (0.0..=120_000.0).contains(&item.milliseconds)
                && item.frame_count <= 1800
                && [item.frame_p50_ms, item.frame_p95_ms, item.frame_max_ms]
                    .iter()
                    .all(|value| {
                        value.is_none_or(|time| {
                            time.is_finite() && (0.0..=120_000.0).contains(&time)
                        })
                    })
        });
    if bounded && let Ok(json) = serde_json::to_string(&report) {
        println!("STELLAR_RECOGNITION_SMOKE {json}");
    }
    app.exit(if bounded && report.success { 0 } else { 1 });
}

fn check_page(window: Webview) {
    // Only this explicit test feature reads the known local synthetic fixture.
    // It is not an IPC path, installed setting, or user microphone recording.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let fixture = root.join("artifacts/native/recognition-probe-input.json");
    let mut bytes = Vec::new();
    let script = std::fs::File::open(fixture)
        .and_then(|file| file.take(3 * 1024 * 1024 + 1).read_to_end(&mut bytes))
        .ok()
        .map(|_| bytes)
        .filter(|raw| raw.len() <= 3 * 1024 * 1024)
        .and_then(|raw| serde_json::from_slice::<Fixture>(&raw).ok())
        .filter(|input| {
            [&input.wake, &input.long]
                .iter()
                .all(|pcm| !pcm.is_empty() && pcm.len() <= 320000)
        })
        .and_then(|input| serde_json::to_string(&input).ok())
        .map(|input| include_str!("recognition_smoke.js").replace("__FIXED_PCM__", &input));
    if script.is_none_or(|script| window.eval(&script).is_err()) {
        window.app_handle().exit(1);
    }
}

pub fn configure(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .invoke_handler(tauri::generate_handler![
            crate::commands::shell_status,
            crate::app_info::app_info,
            crate::telemetry::telemetry_snapshot,
            crate::speech::speech_snapshot,
            crate::speech::speech_keywords,
            crate::speech::speech_transcribe,
            crate::speech::speech_stop,
            recognition_result
        ])
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                check_page(window.clone());
            }
        })
}

pub fn create_window(app: &tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("Recognition smoke requires its fixed main window");
    let profile = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .join("artifacts/native/recognition-webview-profile");
    // The pinned runtime does not copy WindowConfig.data_directory into attributes.
    // Use the explicit builder so test and ordinary WebViews cannot share a browser.
    tauri::WebviewWindowBuilder::from_config(app, config)?
        .data_directory(profile)
        .build()?;
    Ok(())
}
