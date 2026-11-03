use super::*;
use serde_json::json;

fn command() -> std::process::Command {
    let mut command = std::process::Command::new("python");
    command.args([
        "-I",
        "-u",
        "-c",
        r#"
import json,os,sys,time
count=0
for line in sys.stdin:
    request=json.loads(line)
    if request.get('sleep'): time.sleep(10)
    if request.get('oversize'): print('x'*16385,flush=True);continue
    if request.get('exit'): sys.exit(1)
    count+=1
    print(json.dumps({'pid':os.getpid(),'count':count}),flush=True)
"#,
    ]);
    command
}
fn worker() -> WarmWorker {
    let mut worker = WarmWorker::new("fixture");
    worker.command = Some(command);
    worker
}
fn request(worker: &WarmWorker, value: Value) -> Result<Value, SpeechError> {
    worker.request(
        process::payload(value).unwrap(),
        worker.ticket(),
        Duration::from_secs(3),
    )
}

fn resources(pid: u32) -> Value {
    let mut query = std::process::Command::new("python");
    query.args(["-I", "-c", "import json,psutil,sys; p=psutil.Process(int(sys.argv[1])); members=[p,*p.children(recursive=True)]; print(json.dumps({'rss':sum(m.memory_info().rss for m in members),'cpu':sum(sum(m.cpu_times()[:2]) for m in members),'members':[[m.pid,m.create_time()] for m in members]}))"]);
    query.arg(pid.to_string());
    process::configure(&mut query);
    let output = query.output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

fn assert_reaped(resources: &Value) {
    let mut query = std::process::Command::new("python");
    query.args([
        "-I",
        "-c",
        r#"
import json,psutil,sys
for pid,created in json.loads(sys.argv[1]):
    try: assert psutil.Process(pid).create_time()!=created
    except psutil.NoSuchProcess: pass
"#,
    ]);
    query.arg(resources["members"].to_string());
    process::configure(&mut query);
    assert!(query.status().unwrap().success());
}

#[test]
fn persistent_requests_reuse_one_child_and_stop_fences_restart() {
    let worker = worker();
    let first = request(&worker, json!({})).unwrap();
    let second = request(&worker, json!({})).unwrap();
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 2);
    let ticket = worker.ticket();
    worker.stop().unwrap();
    assert!(worker.child.lock().unwrap().is_none());
    assert_eq!(
        worker.request(vec![], ticket, Duration::from_secs(1)),
        Err(SpeechError::Cancelled)
    );
    let fresh = request(&worker, json!({})).unwrap();
    assert_eq!(fresh["count"], 1);
    worker.stop().unwrap();
}

#[test]
fn malformed_output_exit_and_deadline_reap_child_and_allow_recovery() {
    let worker = worker();
    for (value, error) in [
        (json!({"oversize":true}), SpeechError::Protocol),
        (json!({"exit":true}), SpeechError::Unavailable),
    ] {
        assert_eq!(request(&worker, value), Err(error));
        assert!(worker.child.lock().unwrap().is_none());
        assert_eq!(request(&worker, json!({})).unwrap()["count"], 1);
    }
    assert_eq!(
        worker.request(
            process::payload(json!({"sleep":true})).unwrap(),
            worker.ticket(),
            Duration::from_millis(100)
        ),
        Err(SpeechError::Timeout)
    );
    assert!(worker.child.lock().unwrap().is_none());
    assert_eq!(request(&worker, json!({})).unwrap()["count"], 1);
}

#[test]
fn stop_interrupts_waiting_inference_and_concurrent_admission_is_bounded() {
    let worker = Arc::new(worker());
    let running = worker.clone();
    let task = std::thread::spawn(move || request(&running, json!({"sleep":true})));
    let deadline = Instant::now() + Duration::from_secs(2);
    while worker.child.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(request(&worker, json!({})), Err(SpeechError::Busy));
    worker.stop().unwrap();
    assert_eq!(task.join().unwrap(), Err(SpeechError::Cancelled));
    assert!(worker.child.lock().unwrap().is_none());
    assert_eq!(request(&worker, json!({})).unwrap()["count"], 1);
}

#[test]
#[ignore = "Explicit local CPU engines and synthetic fixtures required; no microphone or Ivy call"]
fn installed_offline_engines_reuse_processes_and_recover_after_stop() {
    let engine_request = |worker: &WarmWorker, value: Value| {
        worker.request(
            process::payload(value).unwrap(),
            worker.ticket(),
            Duration::from_secs(if worker.mode == "keywords" { 10 } else { 60 }),
        )
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let source = std::fs::read(root.join("artifacts/native/recognition-probe-input.json")).unwrap();
    assert!(source.len() < 3 * 1024 * 1024);
    let input: Value = serde_json::from_slice(&source).unwrap();
    let keywords = WarmWorker::new("keywords");
    let mut wake = input["wake"].as_array().unwrap().clone();
    wake.extend(vec![json!(0); 16000]);
    let mut detections = vec![];
    let mut chunks = vec![];
    let mut keyword_pid = None;
    for (sequence, pcm) in wake.chunks(640).enumerate() {
        let start = Instant::now();
        let reply = engine_request(
            &keywords,
            json!({"stream_id":"native-qualification", "sequence":sequence,
            "pcm":pcm,"threshold":0.008,"mode":"passive"}),
        )
        .unwrap();
        chunks.push(start.elapsed().as_secs_f64() * 1000.0);
        if reply["detection"].is_object() {
            detections.push(reply["detection"]["command"].clone());
        }
        let pid = keywords.child.lock().unwrap().as_ref().unwrap().id();
        assert_eq!(*keyword_pid.get_or_insert(pid), pid);
    }
    assert_eq!(detections, vec![json!("ivy")]);
    std::thread::sleep(Duration::from_secs(2));
    let keyword_before = resources(keyword_pid.unwrap());
    let idle_start = Instant::now();
    for index in 0..125 {
        let tick = Instant::now();
        let reply = engine_request(
            &keywords,
            json!({"stream_id":"native-qualification",
            "sequence":wake.chunks(640).count()+index,"pcm":vec![0;640],
            "threshold":0.008,"mode":"passive"}),
        )
        .unwrap();
        assert!(reply["detection"].is_null());
        std::thread::sleep(Duration::from_millis(40).saturating_sub(tick.elapsed()));
    }
    let keyword_after = resources(keyword_pid.unwrap());
    let idle_cpu = (keyword_after["cpu"].as_f64().unwrap()
        - keyword_before["cpu"].as_f64().unwrap())
        / idle_start.elapsed().as_secs_f64()
        * 100.0;
    let transcriber = WarmWorker::new("transcribe");
    let payload = json!({"pcm":input["long"],"sample_rate_hz":16000});
    let mut times = vec![];
    let mut transcriber_pid = None;
    let mut previous = None;
    let mut first_stt_rss = 0.0;
    let mut rss_samples = vec![];
    for trial in 0..31 {
        let start = Instant::now();
        let reply = engine_request(&transcriber, payload.clone()).unwrap();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
        assert!(!reply["text"].as_str().unwrap().is_empty());
        if let Some(previous) = &previous {
            assert_eq!(&reply, previous);
        }
        previous = Some(reply);
        let pid = transcriber.child.lock().unwrap().as_ref().unwrap().id();
        assert_eq!(*transcriber_pid.get_or_insert(pid), pid);
        let rss = resources(pid)["rss"].as_f64().unwrap() / 1048576.0;
        rss_samples.push(rss);
        if trial == 0 {
            first_stt_rss = rss;
        }
    }
    let ticket = transcriber.ticket();
    let stt_resources = resources(transcriber_pid.unwrap());
    transcriber.stop().unwrap();
    assert!(transcriber.child.lock().unwrap().is_none());
    assert_reaped(&stt_resources);
    assert_eq!(
        transcriber.request(vec![], ticket, Duration::from_secs(1)),
        Err(SpeechError::Cancelled)
    );
    let start = Instant::now();
    assert_eq!(
        engine_request(&transcriber, payload).unwrap(),
        previous.unwrap()
    );
    let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;
    let recovery_resources = resources(transcriber.child.lock().unwrap().as_ref().unwrap().id());
    transcriber.stop().unwrap();
    keywords.stop().unwrap();
    assert_reaped(&recovery_resources);
    assert_reaped(&keyword_after);
    let evidence = json!({"synthetic":true,"microphoneUsed":false,"llmRequests":0,
        "scope":"Rust-owned persistent CPU workers; no WebView IPC or live microphone",
        "keywordFirstChunkMs":chunks[0],"keywordWarmMaxChunkMs":chunks[1..].iter().copied().fold(0.0, f64::max),
        "keywordDetections":detections,"sttMs":times,"recoveryMs":recovery_ms,
        "keywordRssMiB":keyword_after["rss"].as_f64().unwrap()/1048576.0,
        "sttRssMiB":stt_resources["rss"].as_f64().unwrap()/1048576.0,
        "sttFirstRssMiB":first_stt_rss,
        "sttRssSamplesMiB":rss_samples,
        "streamedSilenceCpuPercentOneCore":idle_cpu,"streamedSilenceSeconds":5,
        "resourceScope":"Sum of root launcher and all recursive descendants; RSS may double-count shared pages",
        "processReuseVerified":true,"stopReapedBothWorkersAndDescendants":true});
    std::fs::write(
        root.join("artifacts/native/recognition-native-worker.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
}
