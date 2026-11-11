use super::{process, warm_worker::WarmWorker};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

const ENRICHMENT_DEADLINE: Duration = Duration::from_millis(1_250);
const ADMISSION_GRACE: Duration = Duration::from_millis(75);
const WORKER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SAMPLES: usize = 16_000 * 6;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct VoiceExpression {
    primary: ExpressionLabel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary: Option<ExpressionLabel>,
    confidence: ExpressionConfidence,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExpressionLabel {
    Angry,
    Disgusted,
    Fearful,
    Happy,
    Neutral,
    Sad,
    Surprised,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExpressionConfidence {
    Moderate,
    High,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    expression: Option<VoiceExpression>,
}

pub(super) struct Analyzer {
    worker: Option<Arc<WarmWorker>>,
    ready: Mutex<Option<(String, Pending)>>,
}

pub(crate) struct Pending {
    worker: Arc<WarmWorker>,
    epoch: u64,
    deadline: Instant,
    result: mpsc::Receiver<(Instant, VoiceExpression)>,
}

impl Analyzer {
    pub(super) fn from_environment() -> Self {
        let enabled = match std::env::var("STELLAR_IVY_VOICE_EXPRESSION").as_deref() {
            Ok(value) => value == "1",
            Err(_) => process::expression_root().is_ok_and(|root| root.join("enabled").is_file()),
        };
        Self {
            worker: enabled.then(|| Arc::new(WarmWorker::new("expression"))),
            ready: Mutex::new(None),
        }
    }

    pub(super) fn ticket(&self) -> Option<u64> {
        self.worker.as_ref().map(|worker| worker.ticket())
    }

    pub(super) fn start(&self, epoch: u64, samples: usize, payload: &[u8]) -> Option<Pending> {
        if !(16_000..=MAX_SAMPLES).contains(&samples) {
            return None;
        }
        let worker = self.worker.as_ref()?.clone();
        if worker.ticket() != epoch {
            return None;
        }
        let deadline = Instant::now() + ENRICHMENT_DEADLINE;
        let (send, result) = mpsc::sync_channel(1);
        let payload = payload.to_vec();
        let running = worker.clone();
        std::thread::Builder::new()
            .name("stellar-voice-expression".into())
            .spawn(move || {
                let Ok(frame) = running.request(payload, epoch, WORKER_TIMEOUT) else {
                    return;
                };
                if let Ok(Reply {
                    expression: Some(expression),
                }) = serde_json::from_value(frame)
                    && expression.secondary.as_ref() != Some(&expression.primary)
                {
                    let _ = send.send((Instant::now(), expression));
                }
            })
            .ok()?;
        Some(Pending {
            worker,
            epoch,
            deadline,
            result,
        })
    }

    pub(super) fn bind(&self, id: String, pending: Pending) {
        if let Ok(mut slot) = self.ready.lock()
            && self.ticket() == Some(pending.epoch)
        {
            *slot = Some((id, pending));
        }
    }

    pub(super) fn take(&self, id: &str) -> Option<Pending> {
        let mut slot = self.ready.lock().ok()?;
        if slot.as_ref().is_some_and(|(ready_id, _)| ready_id == id) {
            return slot.take().map(|(_, pending)| pending);
        }
        None
    }

    pub(super) fn stop(&self) {
        if let Some(worker) = &self.worker {
            let _ = worker.stop();
        }
        if let Ok(mut slot) = self.ready.lock() {
            *slot = None;
        }
    }
}

impl Pending {
    #[cfg(test)]
    pub(crate) fn empty_for_test() -> Self {
        let (_send, result) = mpsc::sync_channel(1);
        Self {
            worker: Arc::new(WarmWorker::new("expression")),
            epoch: 0,
            deadline: Instant::now() + ENRICHMENT_DEADLINE,
            result,
        }
    }

    pub(crate) fn resolve(self) -> Option<VoiceExpression> {
        if self.worker.ticket() != self.epoch {
            return None;
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let (finished, expression) = self
            .result
            .recv_timeout(remaining.min(ADMISSION_GRACE))
            .ok()?;
        (finished <= self.deadline
            && Instant::now() <= self.deadline
            && self.worker.ticket() == self.epoch)
            .then_some(expression)
    }
}

#[cfg(test)]
#[path = "expression_tests.rs"]
mod tests;
