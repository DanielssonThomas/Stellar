use super::*;
use crate::speech::{
    SpeechHost,
    contracts::{SpeechSpeakRequest, SpeechState},
};
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

fn levels(pid: u32) -> Vec<f32> {
    open()
        .expect("Core Audio enumeration")
        .into_iter()
        .filter(|session| session.process == pid)
        .map(|session| session.endpoint.read().expect("session scalar"))
        .collect()
}

fn silent_player(path: &std::path::Path) -> (crate::owned_child::OwnedChild, u32) {
    let mut command = Command::new(r"D:\Hermes\profiles\ivy\voice\.venv\Scripts\python.exe");
    command.args(["-I", "-u", "-c", r#"
import os,sys,wave,winsound
with wave.open(sys.argv[1],'wb') as wav:
    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(bytes(32000))
winsound.PlaySound(sys.argv[1],winsound.SND_FILENAME|winsound.SND_ASYNC|winsound.SND_LOOP|winsound.SND_NODEFAULT)
print(os.getpid(),flush=True)
sys.stdin.readline()
winsound.PlaySound(None,0)
"#]).arg(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = crate::owned_child::OwnedChild::spawn(command).unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    (child, line.trim().parse().expect("actual player identity"))
}

#[test]
#[ignore = "requires installed Ivy voice and real Windows render sessions; speaks one sentence"]
fn real_sessions_duck_other_audio_and_preserve_actual_ivy_worker() {
    let root = std::env::temp_dir().join(format!("stellar-duck-probe-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let audio_path = root.join("silent.wav");
    let (player, player_pid) = silent_player(&audio_path);
    let start = Instant::now();
    let before = loop {
        let found = levels(player_pid);
        if !found.is_empty() || start.elapsed() > Duration::from_secs(3) {
            break found;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        !before.is_empty(),
        "Silent player {player_pid} must own an actual render session; observed {:?}",
        open()
            .unwrap()
            .iter()
            .map(|s| s.process)
            .collect::<Vec<_>>()
    );
    let host = SpeechHost::new(root.join("speech"), Arc::new(|_| {}));
    let speaker = host.audio_process();
    let ducking = VolumeDucking::new(speaker.clone());
    ducking.set_active(true).unwrap();
    host.speak(SpeechSpeakRequest {
        version: 1, epoch: "0".into(), utterance_id: "00000000-0000-0000-0000-000000000286".into(),
        text: "Ivy is speaking clearly while the other audio becomes quieter. This is a local Windows audio session test.".into(),
    }).unwrap();
    let start = Instant::now();
    let during_speech;
    loop {
        assert!(
            start.elapsed() < Duration::from_secs(40),
            "Voice never reached playback"
        );
        ducking.set_active(true).unwrap();
        let state = host.snapshot().unwrap();
        assert_ne!(state.state, SpeechState::Unavailable, "{:?}", state.error);
        if state.state == SpeechState::Speaking {
            let current = levels(speaker.load(Ordering::Acquire));
            if !current.is_empty() {
                during_speech = current;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(900));
    let held_speech = levels(speaker.load(Ordering::Acquire));
    assert_eq!(
        held_speech, during_speech,
        "Ivy's actual session was attenuated"
    );
    let lowered = levels(player_pid);
    assert_eq!(before.len(), lowered.len());
    for (original, current) in before.iter().zip(&lowered) {
        assert!((original * 0.2 - current).abs() < 0.001);
    }
    ducking.set_active(false).unwrap();
    std::thread::sleep(Duration::from_millis(1000));
    let restored = levels(player_pid);
    assert_eq!(restored, before);
    assert_eq!(levels(speaker.load(Ordering::Acquire)), during_speech);
    ducking.shutdown();
    host.shutdown().unwrap();
    drop(player);
    std::fs::remove_file(audio_path).unwrap();
    std::fs::remove_dir(root.join("speech")).unwrap();
    std::fs::remove_dir(root).unwrap();
    let evidence = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../artifacts/native/session-ducking.json");
    std::fs::write(
        evidence,
        serde_json::to_vec_pretty(&serde_json::json!({
            "other_before": before, "other_ducked": lowered, "other_restored": restored,
            "ivy_during_ducking": held_speech, "ivy_after_release": during_speech,
            "actual_worker_pid": speaker.load(Ordering::Acquire), "microphone": false,
            "physical_audibility_measured": false,
        }))
        .unwrap(),
    )
    .unwrap();
}
