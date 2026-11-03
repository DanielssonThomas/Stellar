use super::contracts::MusicLevels;

pub fn stereo_levels(left: MusicLevels, right: MusicLevels) -> MusicLevels {
    let rms = |left: f32, right: f32| {
        (left.hypot(right) * std::f32::consts::FRAC_1_SQRT_2).clamp(0.0, 1.0)
    };
    MusicLevels {
        level: rms(left.level, right.level),
        bass: rms(left.bass, right.bass),
        mid: rms(left.mid, right.mid),
        treble: rms(left.treble, right.treble),
    }
}

pub struct Analyzer {
    low: f32,
    upper: f32,
    low_rate: f32,
    upper_rate: f32,
    sums: [f32; 4],
    count: usize,
}

impl Analyzer {
    pub fn new(sample_rate: u32) -> Self {
        let coefficient = |frequency: f32| {
            1.0 - (-2.0 * std::f32::consts::PI * frequency / sample_rate as f32).exp()
        };
        Self {
            low: 0.0,
            upper: 0.0,
            low_rate: coefficient(250.0),
            upper_rate: coefficient(2500.0),
            sums: [0.0; 4],
            count: 0,
        }
    }

    pub fn sample(&mut self, sample: f32) {
        let sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.low += self.low_rate * (sample - self.low);
        self.upper += self.upper_rate * (sample - self.upper);
        let bands = [sample, self.low, self.upper - self.low, sample - self.upper];
        for (sum, band) in self.sums.iter_mut().zip(bands) {
            *sum += band * band;
        }
        self.count += 1;
    }

    pub fn take(&mut self) -> MusicLevels {
        let values = self.sums.map(|sum| {
            if self.count == 0 {
                0.0
            } else {
                (sum / self.count as f32)
                    .sqrt()
                    .mul_add(5.0, 0.0)
                    .clamp(0.0, 1.0)
            }
        });
        self.sums = [0.0; 4];
        self.count = 0;
        MusicLevels {
            level: values[0],
            bass: values[1],
            mid: values[2],
            treble: values[3],
        }
    }
}
