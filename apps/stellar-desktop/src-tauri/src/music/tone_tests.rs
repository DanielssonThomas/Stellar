use super::tone::ToneAnalyzer;

fn note(frequency: f32, left: f32, right: f32) -> Option<u8> {
    let mut analyzer = ToneAnalyzer::new(48000);
    for i in 0..8192 {
        let value = 0.1 * (std::f32::consts::TAU * frequency * i as f32 / 48000.0).sin();
        analyzer.sample(value * left, value * right);
    }
    analyzer.current()
}

#[test]
fn distinguishes_neighboring_notes_and_preserves_stereo_energy() {
    assert_eq!(note(440.0, 1.0, 1.0), Some(69));
    assert_eq!(note(466.164, 1.0, 1.0), Some(70));
    assert_eq!(note(440.0, 1.0, -1.0), Some(69));
    assert_eq!(note(440.0, 0.0, 1.0), Some(69));
}

#[test]
fn invalid_or_silent_windows_clear_previous_note() {
    let mut analyzer = ToneAnalyzer::new(48000);
    for i in 0..4096 {
        let value = 0.1 * (std::f32::consts::TAU * 440.0 * i as f32 / 48000.0).sin();
        analyzer.sample(value, value);
    }
    assert_eq!(analyzer.current(), Some(69));
    for _ in 0..4096 {
        analyzer.sample(f32::NAN, f32::INFINITY);
    }
    assert_eq!(analyzer.current(), None);
    assert_eq!(note(440.0, 0.0, 0.0), None);
}
