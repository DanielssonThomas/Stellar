use super::*;

fn sample() -> VoiceExpression {
    VoiceExpression {
        primary: ExpressionLabel::Surprised,
        secondary: Some(ExpressionLabel::Happy),
        confidence: ExpressionConfidence::Moderate,
    }
}

#[test]
fn only_the_own_utterances_on_time_result_is_returned() {
    let worker = Arc::new(WarmWorker::new("expression"));
    let enabled = Analyzer {
        worker: Some(worker.clone()),
        ready: Mutex::new(None),
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let pending = |result| Pending {
        worker: worker.clone(),
        epoch: 0,
        deadline,
        result,
    };
    let (late, result) = mpsc::sync_channel(1);
    late.send((deadline + Duration::from_millis(1), sample()))
        .unwrap();
    assert_eq!(pending(result).resolve(), None);

    let (ready, result) = mpsc::sync_channel(1);
    ready.send((Instant::now(), sample())).unwrap();
    enabled.bind("first".into(), pending(result));
    assert!(enabled.take("second").is_none());
    assert_eq!(enabled.take("first").unwrap().resolve(), Some(sample()));
    assert!(enabled.take("first").is_none());

    let (cancelled, result) = mpsc::sync_channel(1);
    cancelled.send((Instant::now(), sample())).unwrap();
    enabled.bind("second".into(), pending(result));
    let taken = enabled.take("second").unwrap();
    enabled.stop();
    assert_eq!(taken.resolve(), None);
}

#[test]
fn absent_worker_and_short_input_never_start_analysis() {
    let disabled = Analyzer {
        worker: None,
        ready: Mutex::new(None),
    };
    assert!(disabled.ticket().is_none());
    let worker = Arc::new(WarmWorker::new("expression"));
    let enabled = Analyzer {
        worker: Some(worker),
        ready: Mutex::new(None),
    };
    let epoch = enabled.ticket().unwrap();
    assert!(enabled.start(epoch, 15_999, b"payload").is_none());
    enabled.stop();
    assert!(enabled.start(epoch, 16_000, b"payload").is_none());
}

#[cfg(windows)]
#[test]
#[ignore = "requires installed offline models and a local genuine speech PCM fixture"]
fn installed_models_bind_expression_to_the_spoken_turn_without_blocking_transcription() {
    use crate::speech::{SpeechHost, contracts::SpeechTranscribeRequest};

    let input = std::env::var_os("STELLAR_IVY_EXPRESSION_PCM").expect("local PCM JSON path");
    let pcm: Vec<i16> = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let host = SpeechHost::new(std::env::temp_dir(), Arc::new(|_| {}));
    assert!(
        host.inner.expression.ticket().is_some(),
        "enable expression for this probe"
    );
    let request = |index, analyze_expression| SpeechTranscribeRequest {
        version: 1,
        epoch: "0".into(),
        utterance_id: format!("00000000-0000-4000-8000-{index:012}"),
        sample_rate_hz: 16_000,
        pcm: pcm.clone(),
        analyze_expression,
    };
    let collect = host
        .collect(request(1, None))
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(!collect.text.trim().is_empty());
    assert!(host.take_expression(&collect.utterance_id).is_none());

    let started = Instant::now();
    let cold = host
        .collect(request(2, Some(true)))
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let transcript_time = started.elapsed();
    let expression = host.take_expression(&cold.utterance_id).unwrap();
    let (finished, _) = expression
        .result
        .recv_timeout(Duration::from_secs(25))
        .unwrap();
    assert!(finished.duration_since(started) > transcript_time);

    let mut attached = 0;
    for index in 3..8 {
        let start = Instant::now();
        let speech = host
            .collect(request(index, Some(true)))
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(speech.text, cold.text);
        let elapsed = start.elapsed();
        assert!(host.take_expression(&cold.utterance_id).is_none());
        // Simulate available session-preparation time before model admission.
        std::thread::sleep(Duration::from_millis(250));
        let used = host
            .take_expression(&speech.utterance_id)
            .and_then(Pending::resolve)
            .is_some();
        println!(
            "transcript_ms={} expression_available={used}",
            elapsed.as_millis()
        );
        attached += usize::from(used);
        assert!(host.take_expression(&speech.utterance_id).is_none());
    }
    assert!(attached > 0, "no result met the local admission deadline");
    host.shutdown().unwrap();
}
