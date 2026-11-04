use super::*;
use std::io::{self, Cursor};

struct Fixture {
    root: PathBuf,
    model: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("stellar-reflex-integrity-{}", token().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let model = root.join("model.gguf");
        std::fs::write(&model, b"not authorized model weights").unwrap();
        Self { root, model }
    }

    fn provenance(&self, value: serde_json::Value) {
        std::fs::write(
            self.model.with_extension("provenance.json"),
            value.to_string(),
        )
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.model.with_extension("provenance.json"));
        let _ = std::fs::remove_file(&self.model);
        let _ = std::fs::remove_dir(&self.root);
    }
}

#[test]
fn streaming_digest_matches_known_vectors_across_buffer_boundaries() {
    for (bytes, expected) in [
        (
            vec![],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            b"abc".to_vec(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            vec![b'a'; 131073],
            "7e009ea4ef882e385b3c0bcbbfa8d009bb0a633bdd764415c09182ee0e75da73",
        ),
    ] {
        assert_eq!(digest(&mut Cursor::new(bytes)).as_deref(), Some(expected));
    }
}

#[test]
fn failed_reads_never_produce_an_accepted_digest() {
    struct Failed;
    impl Read for Failed {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture read failure"))
        }
    }
    assert!(digest(&mut Failed).is_none());
}

#[test]
fn pinned_claims_do_not_accept_changed_weights_or_untrusted_provenance() {
    let fixture = Fixture::new();
    let pinned = serde_json::json!({
        "source": "Qwen/Qwen3-4B-GGUF",
        "revision": "bc640142c66e1fdd12af0bd68f40445458f3869b",
        "sha256": "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        "license": "Apache-2.0"
    });
    fixture.provenance(pinned.clone());
    assert!(verify(&fixture.model).is_none());
    for field in ["source", "revision", "sha256", "license"] {
        let mut changed = pinned.clone();
        changed[field] = "untrusted".into();
        fixture.provenance(changed);
        assert!(verify(&fixture.model).is_none(), "{field}");
    }
    let path = fixture.model.with_extension("provenance.json");
    for bytes in [b"malformed".to_vec(), vec![b' '; 2049]] {
        std::fs::write(&path, bytes).unwrap();
        assert!(verify(&fixture.model).is_none());
    }
    std::fs::remove_file(path).unwrap();
    assert!(verify(&fixture.model).is_none());
}
