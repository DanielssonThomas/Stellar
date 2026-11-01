use super::contracts::*;
use std::sync::{Arc, Mutex};

pub type Publisher = Arc<dyn Fn(IvySnapshot) + Send + Sync>;
pub struct View {
    pub epoch: u64,
    pub snapshot: IvySnapshot,
}
#[derive(Clone)]
pub struct Shared {
    pub view: Arc<Mutex<View>>,
    pub publish: Publisher,
}

impl Shared {
    pub fn update(&self, epoch: u64, change: impl FnOnce(&mut IvySnapshot)) {
        let updated = {
            let Ok(mut view) = self.view.lock() else {
                return;
            };
            if view.epoch != epoch {
                return;
            }
            change(&mut view.snapshot);
            let revision = view.snapshot.revision.parse::<u64>().unwrap_or(0);
            view.snapshot.revision = revision.saturating_add(1).to_string();
            view.snapshot.clone()
        };
        (self.publish)(updated);
    }

    pub fn current(&self, epoch: u64) -> bool {
        self.view.lock().is_ok_and(|view| view.epoch == epoch)
    }
}
