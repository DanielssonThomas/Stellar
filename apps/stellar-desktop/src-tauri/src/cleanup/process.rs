use std::{
    io::{Read, Write},
    process::Command,
    sync::mpsc,
    time::Duration,
};

pub fn refine(raw: &str, host: &super::host::CleanupHost) -> Option<String> {
    let python = crate::ivy::runtime::python().ok()?;
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", include_str!("cleanup_worker.py")]);
    let (mut input, output) = host.spawn(command)?;
    (|| {
        input.write_all(raw.as_bytes()).ok()?;
        drop(input);
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = output.take(32769).read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(result);
        });
        let bytes = rx.recv_timeout(Duration::from_secs(50)).ok()?.ok()?;
        decode(&bytes)
    })()
}

fn decode(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 32768 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let text = value.get("text")?.as_str()?;
    if text.is_empty() || text.len() > 8192 {
        return None;
    }
    Some(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::decode;
    #[test]
    fn bounded_child_frames_are_decoded_and_invalid_frames_rejected() {
        assert_eq!(
            decode(br#"{"text":"corrected"}"#).as_deref(),
            Some("corrected")
        );
        for value in [
            br#"{}"#.as_slice(),
            br#"{"text":""}"#,
            br#"{"text":12}"#,
            b"bad",
        ] {
            assert_eq!(decode(value), None);
        }
        assert_eq!(decode(&vec![b'x'; 32769]), None);
    }
}
