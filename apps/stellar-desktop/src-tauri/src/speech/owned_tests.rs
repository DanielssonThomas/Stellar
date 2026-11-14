use super::*;
use crate::ivy::{lifecycle_ports::*, lifecycle_speech::LifecycleSpeechResources};
use std::path::PathBuf;

const ID: &str = "00000000-0000-0000-0000-000000000001";
fn fixture() -> (SpeechHost, PathBuf) {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let root = std::env::temp_dir().join(format!(
        "stellar-owned-speech-{:x}",
        u128::from_le_bytes(random)
    ));
    (SpeechHost::new(root.clone(), Arc::new(|_| {})), root)
}
fn reserve(host: &SpeechHost) -> (Arc<Operation>, OwnedSpeech) {
    let operation = host
        .reserve(
            ID.into(),
            &host.snapshot().unwrap().epoch,
            SpeechState::Synthesizing,
        )
        .unwrap();
    (operation.clone(), OwnedSpeech::new(host.clone(), operation))
}
fn clean(host: &SpeechHost, root: PathBuf) {
    host.shutdown().unwrap();
    if root.exists() {
        std::fs::remove_dir(root).unwrap();
    }
}
fn lease(id: char, text: &str) -> IvyLifecycleLease {
    IvyLifecycleLease {
        operation: id.to_string().repeat(32),
        kind: IvyLifecycleKind::Speech,
        text: text.into(),
    }
}

#[test]
fn completed_handle_does_not_cancel_same_epoch_replacement_or_shared_child() {
    let (host, root) = fixture();
    let (first, owned) = reserve(&host);
    assert_eq!(owned.completion(), Ok(None));
    host.settle(&first, Ok(String::new())).unwrap();
    assert_eq!(owned.completion(), Ok(Some(SpeechCompletion::Completed)));
    let (second, second_owned) = reserve(&host);
    assert_eq!(host.snapshot().unwrap().epoch, "0");
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        *second.child.lock().unwrap() =
            Some(crate::owned_child::OwnedChild::spawn(command).unwrap());
    }
    for _ in 0..2 {
        assert_eq!(owned.stop(), Ok(SpeechCompletion::Completed));
    }
    assert!(current(&host.inner.view.lock().unwrap(), &second));
    assert!(!second.cancelled.load(Ordering::SeqCst));
    #[cfg(windows)]
    assert!(
        second
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
    );
    assert_eq!(second_owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert!(second.child.lock().unwrap().is_none());
    clean(&host, root);
}

#[cfg(windows)]
#[test]
fn exact_stop_during_inert_warm_request_preserves_replacement_transport() {
    fn command() -> std::process::Command {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
[Console]::WriteLine('{"audio_process":123}')
while ($line=[Console]::ReadLine()) {
 [Console]::WriteLine('{"state":"synthesizing"}')
 [Console]::WriteLine('{"state":"speaking"}')
 [Console]::WriteLine('{"done":true}')
}
"#,
        ]);
        command
    }
    let (host, root) = fixture();
    let (first, owned) = reserve(&host);
    let (ready, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let worker = host.clone();
    let old = std::thread::spawn(move || {
        let result = worker.inner.voice.run_fixture(&first, command(), || {
            worker.speaking(&first)?;
            ready.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        });
        worker.settle(&first, result)
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    let (second, second_owned) = reserve(&host);
    let (new_ready, new_waiting) = std::sync::mpsc::sync_channel(1);
    let (new_release, new_resume) = std::sync::mpsc::sync_channel(1);
    let worker = host.clone();
    let next = second.clone();
    let new = std::thread::spawn(move || {
        let result = worker.inner.voice.run_fixture(&next, command(), || {
            worker.speaking(&next)?;
            new_ready.send(()).unwrap();
            new_resume.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        });
        worker.settle(&next, result)
    });
    assert!(matches!(
        new_waiting.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    assert_eq!(old.join().unwrap(), Err(SpeechError::Cancelled));
    new_waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert!(current(&host.inner.view.lock().unwrap(), &second));
    assert!(!second.cancelled.load(Ordering::SeqCst));
    assert!(
        second
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
    );
    assert_eq!(second_owned.completion(), Ok(None));
    new_release.send(()).unwrap();
    new.join().unwrap().unwrap();
    assert_eq!(
        second_owned.completion(),
        Ok(Some(SpeechCompletion::Completed))
    );
    clean(&host, root);
}

#[test]
fn exact_stop_before_launch_fences_work_without_advancing_the_epoch() {
    let (host, root) = fixture();
    let (first, owned) = reserve(&host);
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert_eq!(
        host.execute(
            &first,
            "speak",
            b"never dispatched".to_vec(),
            Duration::from_millis(50)
        ),
        Err(SpeechError::Cancelled)
    );
    assert!(first.child.lock().unwrap().is_none());
    assert_eq!(host.snapshot().unwrap().epoch, "0");
    let (second, _) = reserve(&host);
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert!(!second.cancelled.load(Ordering::SeqCst));
    clean(&host, root);
}

#[test]
fn resumed_old_settler_and_repeated_stop_cannot_release_a_new_owner() {
    let (host, root) = fixture();
    let (first, owned) = reserve(&host);
    let (ready, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let resume = Mutex::new(resume);
    *host.inner.settlement_gate.lock().unwrap() = Some(Arc::new(move || {
        ready.send(()).unwrap();
        resume
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    }));
    let worker = host.clone();
    let thread = std::thread::spawn(move || worker.settle(&first, Ok(String::new())));
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(owned.completion(), Ok(None));
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    let (second, _) = reserve(&host);
    release.send(()).unwrap();
    assert_eq!(thread.join().unwrap(), Err(SpeechError::Cancelled));
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert!(current(&host.inner.view.lock().unwrap(), &second));
    assert!(!second.cancelled.load(Ordering::SeqCst));
    clean(&host, root);
}

#[test]
fn failed_cleanup_has_no_proof_and_exact_retry_preserves_busy_ownership() {
    let (host, root) = fixture();
    let (operation, owned) = reserve(&host);
    let blocked = operation
        .scratch
        .as_ref()
        .unwrap()
        .output()
        .with_file_name("blocked");
    std::fs::write(&blocked, b"own cleanup failure").unwrap();
    assert_eq!(owned.stop(), Err(SpeechError::Unavailable));
    assert_eq!(owned.completion(), Ok(None));
    assert!(current(&host.inner.view.lock().unwrap(), &operation));
    assert!(matches!(
        host.reserve(ID.into(), "0", SpeechState::Synthesizing),
        Err(SpeechError::Busy)
    ));
    std::fs::remove_file(blocked).unwrap();
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    clean(&host, root);
}

#[test]
fn matching_ids_and_serials_in_another_host_do_not_transfer_ownership() {
    let (first_host, first_root) = fixture();
    let (second_host, second_root) = fixture();
    let (_, first) = reserve(&first_host);
    let (second, second_owned) = reserve(&second_host);
    assert_eq!(first.stop(), Ok(SpeechCompletion::Cancelled));
    assert_eq!(second_owned.completion(), Ok(None));
    assert!(current(&second_host.inner.view.lock().unwrap(), &second));
    assert!(!second.cancelled.load(Ordering::SeqCst));
    clean(&first_host, first_root);
    clean(&second_host, second_root);
}

#[test]
fn failed_backend_outcome_can_have_cleanup_proof_without_claiming_successful_speech() {
    let (host, root) = fixture();
    let (operation, owned) = reserve(&host);
    assert_eq!(
        host.settle(&operation, Err(SpeechError::Protocol)),
        Err(SpeechError::Protocol)
    );
    assert_eq!(
        owned.completion(),
        Ok(Some(SpeechCompletion::Failed(SpeechError::Protocol)))
    );
    assert_eq!(
        owned.stop(),
        Ok(SpeechCompletion::Failed(SpeechError::Protocol))
    );
    clean(&host, root);
}

#[test]
fn public_owned_admission_returns_its_actual_handle_after_reentrant_replacement() {
    let holder = Arc::new(Mutex::new(None::<SpeechHost>));
    let observed = holder.clone();
    let (base, root) = fixture();
    drop(base);
    let host = SpeechHost::new(
        root.clone(),
        Arc::new(move |snapshot| {
            if snapshot.state == SpeechState::Synthesizing {
                let host = observed.lock().unwrap().clone().unwrap();
                host.stop_epoch("0").unwrap();
                host.reserve(ID.into(), "1", SpeechState::Transcribing)
                    .unwrap();
            }
        }),
    );
    *holder.lock().unwrap() = Some(host.clone());
    let owned = host
        .speak_owned(SpeechSpeakRequest {
            version: 1,
            epoch: "0".into(),
            utterance_id: ID.into(),
            text: "never dispatched".into(),
        })
        .unwrap();
    assert_eq!(owned.stop(), Ok(SpeechCompletion::Cancelled));
    let view = host.inner.view.lock().unwrap();
    assert_eq!(view.snapshot.epoch, "1");
    assert_eq!(view.snapshot.state, SpeechState::Transcribing);
    assert!(
        !view
            .active
            .as_ref()
            .unwrap()
            .cancelled
            .load(Ordering::SeqCst)
    );
    drop(view);
    *holder.lock().unwrap() = None;
    clean(&host, root);
}

#[test]
fn inactive_adapter_fences_absent_work_and_retains_exact_native_completion() {
    let (host, root) = fixture();
    let mut adapter = LifecycleSpeechResources::new(host.clone()).unwrap();
    let a = lease('a', "original canonical answer");
    let operation = Arc::new(Mutex::new(None::<Arc<Operation>>));
    let captured = operation.clone();
    adapter
        .apply_using(&a, |request| {
            validation::speak(&request).unwrap();
            assert_eq!(request.utterance_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
            let (op, handle) = reserve(&host);
            *captured.lock().unwrap() = Some(op);
            Ok(handle)
        })
        .unwrap();
    assert_eq!(adapter.completion(&a.operation), Ok(None));
    adapter.stop(&a.operation).unwrap();
    assert_eq!(
        adapter.completion(&a.operation),
        Ok(Some(SpeechCompletion::Cancelled))
    );
    assert!(
        operation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .cancelled
            .load(Ordering::SeqCst)
    );
    assert_eq!(
        adapter.apply_using(&a, |_| panic!("duplicate launch")),
        Err(crate::ivy::contracts::IvyErrorCode::Uncertain)
    );
    let b = lease('b', "queued answer");
    adapter.stop(&b.operation).unwrap();
    assert_eq!(
        adapter.apply_using(&b, |_| panic!("late launch")),
        Err(crate::ivy::contracts::IvyErrorCode::Uncertain)
    );
    adapter.close().unwrap();
    clean(&host, root);
}

#[test]
fn adapter_does_not_retry_failed_admission_or_allow_conflicting_text() {
    let (host, root) = fixture();
    let mut adapter = LifecycleSpeechResources::new(host.clone()).unwrap();
    let a = lease('a', "answer");
    assert!(adapter.apply_using(&a, |_| Err(SpeechError::Busy)).is_err());
    adapter.stop(&a.operation).unwrap();
    let mut changed = a.clone();
    changed.text = "changed".into();
    assert_eq!(
        adapter.apply_using(&changed, |_| panic!("changed launch")),
        Err(crate::ivy::contracts::IvyErrorCode::Protocol)
    );
    adapter.close().unwrap();
    clean(&host, root);
}

#[test]
fn adapter_reconstruction_cannot_forget_live_or_closed_registry_fences() {
    for close in [false, true] {
        let (host, root) = fixture();
        let mut adapter = LifecycleSpeechResources::new(host.clone()).unwrap();
        adapter
            .apply_using(&lease('a', "answer"), |_| Ok(reserve(&host).1))
            .unwrap();
        assert!(LifecycleSpeechResources::new(host.clone()).is_err());
        if close {
            adapter.close().unwrap();
        }
        drop(adapter);
        assert!(LifecycleSpeechResources::new(host.clone()).is_err());
        clean(&host, root);
    }
}

#[test]
fn adapter_close_preserves_failure_and_can_retry_exact_cleanup_without_new_speech() {
    let (host, root) = fixture();
    let mut adapter = LifecycleSpeechResources::new(host.clone()).unwrap();
    let a = lease('a', "long".repeat(1100).as_str());
    let (operation, owned) = reserve(&host);
    let blocked = operation
        .scratch
        .as_ref()
        .unwrap()
        .output()
        .with_file_name("blocked");
    std::fs::write(&blocked, b"cleanup failure").unwrap();
    adapter
        .apply_using(&a, |request| {
            assert!(request.text.len() < 4000);
            Ok(owned)
        })
        .unwrap();
    assert!(adapter.close().is_err());
    assert_eq!(adapter.completion(&a.operation), Ok(None));
    std::fs::remove_file(blocked).unwrap();
    adapter.close().unwrap();
    assert_eq!(
        adapter.completion(&a.operation),
        Ok(Some(SpeechCompletion::Cancelled))
    );
    assert!(
        adapter
            .apply_using(&lease('b', "new"), |_| panic!("closed launch"))
            .is_err()
    );
    clean(&host, root);
}
