use super::{contracts::*, process::ChildSlot, scratch::Scratch};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

pub(super) type Publisher = Arc<dyn Fn(SpeechSnapshot) + Send + Sync>;
#[cfg(test)]
pub(super) type SettlementGate = Arc<dyn Fn() + Send + Sync>;
pub(super) struct Operation {
    pub(super) serial: u64,
    pub(super) child: ChildSlot,
    pub(super) cancelled: AtomicBool,
    pub(super) scratch: Option<Scratch>,
}
pub(super) struct View {
    pub(super) snapshot: SpeechSnapshot,
    pub(super) active: Option<Arc<Operation>>,
    pub(super) serial: u64,
    pub(super) closed: bool,
    pub(super) epoch: u64,
}
pub(super) struct Inner {
    pub(super) view: Mutex<View>,
    pub(super) publish: Publisher,
    pub(super) scratch: PathBuf,
    #[cfg(test)]
    pub(super) settlement_gate: Mutex<Option<SettlementGate>>,
}
pub(super) fn current(view: &View, operation: &Operation) -> bool {
    view.active
        .as_ref()
        .is_some_and(|active| active.serial == operation.serial)
}
pub(super) fn advance(view: &mut View) -> SpeechSnapshot {
    let revision = view
        .snapshot
        .revision
        .parse::<u64>()
        .unwrap_or_default()
        .saturating_add(1);
    view.snapshot.revision = revision.to_string();
    view.snapshot.clone()
}
