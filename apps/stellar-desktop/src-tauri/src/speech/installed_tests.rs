use super::*;
use serde_json::json;

/// Opt-in integration qualification. Uses the actual Windows output device, no microphone or LLM.
#[test]
#[ignore = "requires installed Ivy Kokoro assets and Windows speaker playback"]
fn installed_warm_speech_reuses_recovers_and_cleans_up() {
    let root = std::env::temp_dir().join(format!("stellar-warm-native-{}", std::process::id()));
    let host = SpeechHost::new(root.clone(), Arc::new(|_| {}));
    let mut runs = vec![];
    let mut first_pid = None;
    for index in 0..13 {
        let start = Instant::now();
        host.speak(SpeechSpeakRequest {
            version: 1,
            epoch: host.snapshot().unwrap().epoch,
            utterance_id: format!("00000000-0000-0000-0000-{index:012}"),
            text: "I can help with that. Let us work through the next steps together.".into(),
        })
        .unwrap();
        let mut first_audio_ms = None;
        let mut playback_ms = None;
        loop {
            assert!(start.elapsed() < Duration::from_secs(30));
            let snapshot = host.snapshot().unwrap();
            if snapshot.timings.as_ref().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.stage == SpeechTimingStage::FirstAudio)
            }) {
                first_audio_ms.get_or_insert(start.elapsed().as_millis() as u64);
            }
            if snapshot.state == SpeechState::Speaking {
                playback_ms.get_or_insert(start.elapsed().as_millis() as u64);
            }
            if snapshot.state == SpeechState::Idle {
                assert!(first_audio_ms.is_some());
                assert!(playback_ms.is_some());
                runs.push(json!({"first_audio_observed_ms":first_audio_ms,"playback_dispatched_observed_ms":playback_ms,"completed_ms":start.elapsed().as_millis() as u64,"worker_timings":snapshot.timings}));
                break;
            }
            assert_ne!(
                snapshot.state,
                SpeechState::Unavailable,
                "{:?}",
                snapshot.error
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid = host
            .inner
            .voice
            .child
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .id();
        assert_eq!(*first_pid.get_or_insert(pid), pid);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
    // Interrupt both synthesis and actual playback, then recover on this same host.
    for during_playback in [false, true] {
        host.speak(SpeechSpeakRequest { version: 1, epoch: host.snapshot().unwrap().epoch,
            utterance_id: identity(), text: "This synthetic cancellation exercise has several complete sentences. The next sentence is prepared while the first sentence plays.".into() }).unwrap();
        if during_playback {
            let start = Instant::now();
            while host.snapshot().unwrap().state != SpeechState::Speaking {
                assert!(start.elapsed() < Duration::from_secs(30));
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        host.stop_epoch(&host.snapshot().unwrap().epoch).unwrap();
        assert!(host.inner.voice.child.lock().unwrap().is_none());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
    host.speak(SpeechSpeakRequest {
        version: 1,
        epoch: host.snapshot().unwrap().epoch,
        utterance_id: identity(),
        text: "The local voice has recovered.".into(),
    })
    .unwrap();
    let start = Instant::now();
    while host.snapshot().unwrap().state != SpeechState::Idle {
        assert!(start.elapsed() < Duration::from_secs(30));
        assert_ne!(host.snapshot().unwrap().state, SpeechState::Unavailable);
        std::thread::sleep(Duration::from_millis(5));
    }
    let recovered = host
        .inner
        .voice
        .child
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .id();
    assert_ne!(Some(recovered), first_pid);
    host.shutdown().unwrap();
    assert!(host.inner.voice.child.lock().unwrap().is_none());
    std::fs::remove_dir(root).unwrap();
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/native");
    std::fs::create_dir_all(&evidence).unwrap();
    std::fs::write(evidence.join("warm-native-speech.json"), serde_json::to_vec_pretty(&json!({
        "llm_requests":0,"microphone":false,"windows_playback_api":true,"physical_audibility_measured":false,
        "reused_pid":first_pid,"recovered_pid":recovered,"runs":runs,"cancel_synthesis_and_playback":true,"scratch_removed":true
    })).unwrap()).unwrap();
}

fn identity() -> String {
    "00000000-0000-0000-0000-000000000099".into()
}
