use super::{
    Session,
    ramp::{Progress, Ramp},
};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

#[derive(Default)]
pub(super) struct Mixer {
    ramps: HashMap<String, (u32, Ramp)>,
    overridden: HashSet<String>,
}

impl Mixer {
    pub fn is_empty(&self) -> bool {
        self.ramps.is_empty()
    }

    pub fn discover(&mut self, sessions: Vec<Session>, speaker: u32) {
        let mut present = HashSet::new();
        for session in sessions.into_iter().take(256) {
            if (speaker != 0 && session.process == speaker) || session.process == std::process::id()
            {
                continue;
            }
            present.insert(session.id.clone());
            if self.ramps.len() + self.overridden.len() >= 256
                || self.overridden.contains(&session.id)
                || self.ramps.contains_key(&session.id)
            {
                continue;
            }
            if let Ok(ramp) = Ramp::new(session.endpoint) {
                self.ramps.insert(session.id, (session.process, ramp));
            }
        }
        self.ramps.retain(|id, _| present.contains(id));
    }

    pub fn tick(&mut self, active: bool, elapsed: Duration, speaker: u32) {
        self.ramps.retain(|id, (process, ramp)| {
            if (speaker != 0 && *process == speaker) || !ramp.is_current() {
                return false;
            }
            match ramp.tick(active, elapsed) {
                Progress::Pending => true,
                Progress::Restored => false,
                Progress::Overridden => {
                    if active {
                        self.overridden.insert(id.clone());
                    }
                    false
                }
            }
        });
        if !active {
            self.overridden.clear();
        }
    }
}
