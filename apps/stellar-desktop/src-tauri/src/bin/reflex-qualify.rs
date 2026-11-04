#![forbid(unsafe_code)]
#[path = "../reflex/admission.rs"]
mod admission;
#[allow(dead_code)]
#[path = "../reflex/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../reflex/media_host.rs"]
mod media_host;
#[allow(dead_code)]
#[path = "../reflex/model.rs"]
mod model;
#[allow(dead_code)]
#[path = "../owned_child.rs"]
mod owned_child;
#[path = "../reflex/process.rs"]
mod process;
#[path = "../reflex/prompt.rs"]
mod prompt;
#[path = "../reflex/qualification.rs"]
mod qualification;
#[path = "../reflex/setup.rs"]
mod setup;
use serde_json::{Value, json};
use std::{collections::HashSet, time::Instant};

// Qualification links a fixture media port, never a Windows executor or microphone.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--corpus" {
        return Err(
            "Usage: reflex-qualify --corpus PATH (requires explicitly configured installed model)"
                .into(),
        );
    }
    if std::env::var_os("STELLAR_REFLEX_MODEL").is_none()
        || std::env::var_os("STELLAR_REFLEX_LLAMA").is_none()
    {
        return Err("Model not configured; no downloads or inference started".into());
    }
    let corpus: Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let host = model::ReflexHost::default();
    host.set_enabled(true);
    let mut samples = Vec::new();
    let mut correct = 0;
    let mut unavailable = 0;
    let mut replies = HashSet::new();
    let mut history: Vec<String> = Vec::new();
    let started = Instant::now();
    for (index, case) in corpus["cases"]
        .as_array()
        .ok_or("Missing cases")?
        .iter()
        .enumerate()
    {
        let scenario = &corpus["contexts"][case["scenario"].as_str().ok_or("Missing scenario")?];
        let r = contracts::ReflexRequest {
            version: 1,
            input_id: format!("qualification-{index}"),
            text: case["text"].as_str().ok_or("Missing text")?.into(),
            mode: if index % 2 == 0 {
                contracts::ReflexMode::Playful
            } else {
                contracts::ReflexMode::Professional
            },
            context: scenario["context"].to_string(),
            history: if corpus["rolling_history"].as_bool() == Some(true) {
                history.clone()
            } else {
                serde_json::from_value(case.get("history").cloned().unwrap_or(json!([])))?
            },
            actions: serde_json::from_value(scenario["actions"].clone())?,
        };
        let before = Instant::now();
        let plan = tauri::async_runtime::block_on(host.infer(&r));
        let mock_media_dispatch_confirmed = plan
            .as_ref()
            .and_then(|p| qualification::dispatch(p, &r.input_id));
        let elapsed = before.elapsed().as_secs_f64() * 1000.;
        let actual = plan.as_ref().map(serde_json::to_value).transpose()?;
        let passed = actual.as_ref().is_some_and(|p| {
            p["route"] == case["expected"]["route"]
                && p["action_id"] == case["expected"]["action_id"]
        });
        if passed {
            correct += 1;
        }
        if let Some(p) = &plan {
            replies.insert(p.reply.clone());
            if corpus["rolling_history"].as_bool() == Some(true) {
                history.push(
                    json!({"user":r.text.chars().take(70).collect::<String>(),"ivy":p.reply})
                        .to_string(),
                );
                if history.len() > 3 {
                    history.remove(0);
                }
            }
        } else {
            unavailable += 1;
        }
        samples.push(elapsed);
        println!(
            "{}",
            json!({"case": case["id"], "ms": elapsed, "passed": passed, "plan": actual, "mock_media_dispatch_confirmed": mock_media_dispatch_confirmed})
        );
    }
    host.shutdown();
    let cold = samples.first().copied();
    samples.sort_by(f64::total_cmp);
    let percentile = |p: f64| {
        samples
            .get((samples.len() as f64 * p).ceil() as usize - 1)
            .copied()
    };
    println!(
        "{}",
        json!({"summary": {"count": samples.len(), "correct": correct, "unavailable": unavailable,
        "distinct_replies": replies.len(), "cold_ms": cold, "p50_ms_including_failures": percentile(0.5),
        "p95_ms_including_failures": percentile(0.95), "total_seconds": started.elapsed().as_secs_f64(),
        "gpu_layers": std::env::var("STELLAR_REFLEX_GPU_LAYERS").unwrap_or_else(|_| "0".into()),
        "scope": "inference and safe mocked native media registry; no microphone, real actions or acknowledgment audio"}})
    );
    Ok(())
}
