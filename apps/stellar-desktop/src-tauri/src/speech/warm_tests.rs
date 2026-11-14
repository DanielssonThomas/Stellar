use super::*;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

fn operation(voice: &WarmVoice) -> Operation {
    Operation {
        admitted: crate::speech::contracts::SpeechSnapshot::default(),
        serial: 1,
        child: voice.child.clone(),
        cancelled: AtomicBool::new(false),
        scratch: None,
        recognition_epoch: 0,
        expression_epoch: None,
        completion: Mutex::new(None),
    }
}

fn command() -> Result<Command, SpeechError> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        r#"
[Console]::WriteLine(('{"audio_process":' + $PID + '}'))
while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'crash') { exit 7 }
    if ($line -eq 'hold') { Start-Sleep -Seconds 10 }
    if ($line -eq 'malformed') { [Console]::WriteLine('{"private":"refused"}'); continue }
    [Console]::WriteLine('{"state":"synthesizing"}')
    [Console]::WriteLine('{"state":"speaking"}')
    [Console]::WriteLine('{"done":true}')
}
"#,
    ]);
    Ok(cmd)
}

fn run(voice: &WarmVoice, op: &Operation, payload: &str) -> Result<String, SpeechError> {
    voice.run_using(
        op,
        payload.as_bytes().to_vec(),
        Instant::now() + Duration::from_secs(3),
        || Ok(()),
        |_| Ok(()),
        command,
    )
}

#[test]
fn repeated_requests_reuse_child_and_crash_restarts_without_host_restart() {
    let voice = WarmVoice::default();
    let op = operation(&voice);
    run(&voice, &op, "one\n").unwrap();
    let first = voice.child.lock().unwrap().as_ref().unwrap().id();
    assert_eq!(voice.audio_process.load(Ordering::Acquire), first);
    for _ in 0..3 {
        run(&voice, &op, "next\n").unwrap();
    }
    assert_eq!(voice.child.lock().unwrap().as_ref().unwrap().id(), first);
    assert_eq!(run(&voice, &op, "crash\n"), Err(SpeechError::Unavailable));
    run(&voice, &op, "fresh\n").unwrap();
    assert_ne!(voice.child.lock().unwrap().as_ref().unwrap().id(), first);
    assert_eq!(
        voice.audio_process.load(Ordering::Acquire),
        voice.child.lock().unwrap().as_ref().unwrap().id()
    );
    process::stop(&voice.child).unwrap();
    assert!(voice.child.lock().unwrap().is_none());
}

#[test]
fn cancellation_during_synthesis_reaps_child_and_allows_a_fresh_operation() {
    let voice = Arc::new(WarmVoice::default());
    let op = Arc::new(operation(&voice));
    run(&voice, &op, "warm\n").unwrap();
    let worker = voice.clone();
    let active = op.clone();
    let pending = std::thread::spawn(move || run(&worker, &active, "hold\n"));
    std::thread::sleep(Duration::from_millis(50));
    op.cancelled.store(true, Ordering::SeqCst);
    process::stop(&voice.child).unwrap();
    assert!(pending.join().unwrap().is_err());
    let fresh = operation(&voice);
    run(&voice, &fresh, "fresh\n").unwrap();
    let pid = voice.child.lock().unwrap().as_ref().unwrap().id();
    assert_eq!(run(&voice, &op, "late\n"), Err(SpeechError::Cancelled));
    assert_eq!(voice.child.lock().unwrap().as_ref().unwrap().id(), pid);
}

#[test]
fn malformed_worker_frames_fail_closed_and_stop_reaps_idle_child() {
    let voice = WarmVoice::default();
    let op = operation(&voice);
    assert_eq!(run(&voice, &op, "malformed\n"), Err(SpeechError::Protocol));
    process::stop(&voice.child).unwrap();
    run(&voice, &op, "fresh\n").unwrap();
    process::stop(&voice.child).unwrap();
    assert!(voice.child.lock().unwrap().is_none());
}
