use super::*;

fn identity() -> String {
    "00000000-0000-0000-0000-000000000001".into()
}

#[test]
fn invalid_pcm_and_identity_never_reserve_work() {
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-invalid"),
        Arc::new(|_| {}),
    );
    let request = SpeechTranscribeRequest {
        version: 1,
        utterance_id: "bad".into(),
        sample_rate_hz: 16_000,
        pcm: vec![0],
    };
    assert!(matches!(
        host.transcribe(request),
        Err(SpeechError::MalformedRequest)
    ));
    assert_eq!(host.snapshot().unwrap().state, SpeechState::Idle);
}

#[test]
fn synchronous_stop_during_admission_prevents_process_launch() {
    let holder = Arc::new(Mutex::new(None::<SpeechHost>));
    let observed = holder.clone();
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-reentrant"),
        Arc::new(move |snapshot| {
            if snapshot.state == SpeechState::Transcribing {
                let host = observed.lock().unwrap().clone().unwrap();
                host.stop().unwrap();
            }
        }),
    );
    *holder.lock().unwrap() = Some(host.clone());
    let completion = host
        .transcribe(SpeechTranscribeRequest {
            version: 1,
            utterance_id: identity(),
            sample_rate_hz: 16000,
            pcm: vec![0; 16],
        })
        .unwrap();
    assert!(matches!(
        completion.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(SpeechError::Cancelled)
    ));
    assert!(host.inner.view.lock().unwrap().active.is_none());
    assert_eq!(host.snapshot().unwrap().state, SpeechState::Idle);
    *holder.lock().unwrap() = None;
}

#[test]
fn busy_cancel_and_stale_completion_preserve_new_owner() {
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-owners"),
        Arc::new(|_| {}),
    );
    let first = host.reserve(identity(), SpeechState::Transcribing).unwrap();
    assert!(matches!(
        host.reserve(identity(), SpeechState::Transcribing),
        Err(SpeechError::Busy)
    ));
    host.stop().unwrap();
    let second = host.reserve(identity(), SpeechState::Transcribing).unwrap();
    assert!(matches!(
        host.settle(&first, Ok("late text".into())),
        Err(SpeechError::Cancelled)
    ));
    assert!(current(&host.inner.view.lock().unwrap(), &second));
    host.stop().unwrap();
}

#[test]
fn shutdown_seals_admission_before_a_delayed_command_can_reserve() {
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-shutdown"),
        Arc::new(|_| {}),
    );
    let (ready, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let delayed = host.clone();
    let thread = std::thread::spawn(move || {
        let request = SpeechTranscribeRequest {
            version: 1,
            utterance_id: identity(),
            sample_rate_hz: 16000,
            pcm: vec![0; 16],
        };
        validation::transcribe(&request).unwrap();
        ready.send(()).unwrap();
        resume.recv().unwrap();
        assert!(matches!(
            delayed.transcribe(request),
            Err(SpeechError::Unavailable)
        ));
    });
    waiting.recv().unwrap();
    host.shutdown().unwrap();
    release.send(()).unwrap();
    thread.join().unwrap();
    host.stop().unwrap();
    host.shutdown().unwrap();
    assert!(matches!(
        host.reserve(identity(), SpeechState::Synthesizing),
        Err(SpeechError::Unavailable)
    ));
    assert!(host.inner.view.lock().unwrap().active.is_none());
}

#[test]
fn shutdown_cancels_existing_admission_and_refuses_reentrant_new_work() {
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-shutdown-active"),
        Arc::new(|_| {}),
    );
    let operation = host.reserve(identity(), SpeechState::Transcribing).unwrap();
    host.shutdown().unwrap();
    assert!(operation.cancelled.load(Ordering::SeqCst));
    assert!(matches!(
        host.execute(&operation, "transcribe", vec![], Duration::from_secs(1)),
        Err(SpeechError::Cancelled)
    ));
    assert!(matches!(
        host.reserve(identity(), SpeechState::Transcribing),
        Err(SpeechError::Unavailable)
    ));
}

#[test]
fn cancellation_between_cleanup_and_settlement_cannot_return_a_transcript() {
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-settlement"),
        Arc::new(|_| {}),
    );
    let operation = host.reserve(identity(), SpeechState::Transcribing).unwrap();
    let (ready, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let resume = Mutex::new(resume);
    *host.inner.settlement_gate.lock().unwrap() = Some(Arc::new(move || {
        ready.send(()).unwrap();
        resume.lock().unwrap().recv().unwrap();
    }));
    let worker = host.clone();
    let thread =
        std::thread::spawn(move || worker.settle(&operation, Ok("must not submit".into())));
    waiting.recv().unwrap();
    {
        let view = host.inner.view.lock().unwrap();
        view.active
            .as_ref()
            .unwrap()
            .cancelled
            .store(true, Ordering::SeqCst);
    }
    release.send(()).unwrap();
    assert!(matches!(
        thread.join().unwrap(),
        Err(SpeechError::Cancelled)
    ));
    assert_eq!(host.snapshot().unwrap().error, Some(SpeechError::Cancelled));
    assert!(host.inner.view.lock().unwrap().active.is_none());
}

#[test]
fn temporary_audio_is_removed_after_stop_and_cannot_reappear_from_stale_work() {
    let root = std::env::temp_dir().join(format!("stellar-speech-scratch-{}", std::process::id()));
    let host = SpeechHost::new(root.clone(), Arc::new(|_| {}));
    let operation = host.reserve(identity(), SpeechState::Synthesizing).unwrap();
    let output = operation.scratch.as_ref().unwrap().output();
    std::fs::write(&output, b"temporary audio").unwrap();
    std::fs::write(output.with_file_name("reply.tmp.wav"), b"partial").unwrap();
    host.stop().unwrap();
    assert!(!output.parent().unwrap().exists());
    assert!(matches!(
        host.execute(&operation, "speak", vec![], Duration::from_secs(1)),
        Err(SpeechError::Cancelled)
    ));
    std::fs::remove_dir(root).unwrap();
}

#[cfg(windows)]
#[test]
fn stopping_real_inert_worker_reaps_it_and_preserves_an_unrelated_process() {
    use std::{os::windows::process::CommandExt, process::Command};
    let command = || {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep 10",
        ]);
        cmd.creation_flags(0x08000000);
        cmd
    };
    let host = SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-process"),
        Arc::new(|_| {}),
    );
    let operation = host.reserve(identity(), SpeechState::Transcribing).unwrap();
    let _frames = process::spawn(command(), &operation.child, b"{}\n".to_vec()).unwrap();
    let mut unrelated = command().spawn().unwrap();
    host.stop().unwrap();
    let alive = unrelated.try_wait().unwrap().is_none();
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    assert!(alive);
    assert!(operation.child.lock().unwrap().is_none());
    assert!(host.inner.view.lock().unwrap().active.is_none());
}
