use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::Path;

const TEXT: &str = "Mm, let me check.";
const AUDIO: &[u8] = include_bytes!("acknowledgment.wav");

pub(super) fn payload(text: String, output: &Path) -> Value {
    let mut payload = json!({"text": text, "output": output});
    if payload["text"] == TEXT {
        payload["cached_wav"] = json!(STANDARD.encode(AUDIO));
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn only_the_fixed_phrase_receives_the_bundled_audio() {
        let fixed = payload(TEXT.into(), Path::new("reply.wav"));
        let encoded = fixed["cached_wav"].as_str().unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), AUDIO);
        assert!(encoded.len() < 100_000);
        assert_eq!(
            format!("{:x}", Sha256::digest(AUDIO)),
            "762c2f8958c715db47b92c4f80028b38eb0e4e84c09bdb11531e1696d783eee8"
        );
        for text in [
            "Let me check.",
            "Mm, let me check. More text",
            "mm, let me check.",
        ] {
            assert!(
                payload(text.into(), Path::new("reply.wav"))
                    .get("cached_wav")
                    .is_none()
            );
        }
    }
}
