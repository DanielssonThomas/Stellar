const WINDOW: usize = 4096;
const FIRST_NOTE: u8 = 36;
const NOTES: usize = 60;

/// A dominant note-centered spectral bin for visual routing, not transcription.
pub struct ToneAnalyzer {
    channels: [Vec<f32>; 2],
    weights: Vec<f32>,
    coefficients: [f64; NOTES],
    tone: Option<u8>,
}

impl ToneAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            channels: [Vec::with_capacity(WINDOW), Vec::with_capacity(WINDOW)],
            weights: (0..WINDOW)
                .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WINDOW - 1) as f32).cos())
                .collect(),
            coefficients: std::array::from_fn(|i| {
                let frequency =
                    440.0 * 2.0_f64.powf((f64::from(FIRST_NOTE) + i as f64 - 69.0) / 12.0);
                2.0 * (std::f64::consts::TAU * frequency / f64::from(sample_rate)).cos()
            }),
            tone: None,
        }
    }

    pub fn sample(&mut self, left: f32, right: f32) {
        for (channel, sample) in self.channels.iter_mut().zip([left, right]) {
            channel.push(if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            });
        }
        if self.channels[0].len() < WINDOW {
            return;
        }
        // Selecting a channel preserves antiphase stereo and right-only output.
        let energy = self
            .channels
            .each_ref()
            .map(|channel| channel.iter().map(|x| x * x).sum::<f32>());
        let channel = &self.channels[usize::from(energy[1] > energy[0])];
        self.tone = if energy[0].max(energy[1]) / (WINDOW as f32) < 0.000_001 {
            None
        } else {
            self.coefficients
                .iter()
                .enumerate()
                .map(|(i, coefficient)| {
                    let (mut previous, mut older) = (0.0, 0.0);
                    for (sample, weight) in channel.iter().zip(&self.weights) {
                        let next = f64::from(sample * weight) + coefficient * previous - older;
                        older = previous;
                        previous = next;
                    }
                    (
                        i,
                        previous * previous + older * older - coefficient * previous * older,
                    )
                })
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(i, _)| FIRST_NOTE + i as u8)
        };
        for channel in &mut self.channels {
            channel.fill(0.0);
            channel.clear();
        }
    }

    pub fn current(&self) -> Option<u8> {
        self.tone
    }
}
