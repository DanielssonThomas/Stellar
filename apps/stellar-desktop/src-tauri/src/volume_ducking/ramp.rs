use std::time::Duration;

pub(crate) trait Endpoint {
    fn read(&self) -> Result<f32, ()>;
    fn write(&self, level: f32) -> Result<(), ()>;
    fn is_current(&self) -> bool;
}

pub(super) enum Progress {
    Pending,
    Restored,
    Overridden,
}

pub(super) struct Ramp {
    endpoint: Box<dyn Endpoint>,
    original: f32,
    last: f32,
    owned: bool,
}

impl Ramp {
    pub fn new(endpoint: Box<dyn Endpoint>) -> Result<Self, ()> {
        let original = endpoint.read()?;
        if !original.is_finite() || !(0.0..=1.0).contains(&original) {
            return Err(());
        }
        Ok(Self {
            endpoint,
            original,
            last: original,
            owned: true,
        })
    }

    pub fn is_current(&self) -> bool {
        self.endpoint.is_current()
    }

    pub fn tick(&mut self, active: bool, elapsed: Duration) -> Progress {
        let Ok(observed) = self.endpoint.read() else {
            return Progress::Pending;
        };
        // Explicit user/other-application adjustments supersede our saved level.
        if (observed - self.last).abs() > 0.0001 {
            self.owned = false;
            return Progress::Overridden;
        }
        let target = if active {
            self.original * 0.2
        } else {
            self.original
        };
        let step = self.original * 0.8 * (elapsed.as_secs_f32() / 0.8).min(1.0);
        let next = self.last + (target - self.last).clamp(-step, step);
        if next == self.last || self.endpoint.write(next).is_ok() {
            self.last = next;
        }
        if !active && (self.last - self.original).abs() < f32::EPSILON {
            self.owned = false;
            Progress::Restored
        } else {
            Progress::Pending
        }
    }

    pub fn restore(&mut self) {
        if self.owned
            && self
                .endpoint
                .read()
                .is_ok_and(|v| (v - self.last).abs() <= 0.0001)
            && self.endpoint.write(self.original).is_ok()
        {
            self.owned = false;
        }
    }
}

impl Drop for Ramp {
    fn drop(&mut self) {
        self.restore();
    }
}
