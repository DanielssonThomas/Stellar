use super::*;

impl ReflexHost {
    pub async fn prepare(&self) -> bool {
        self.prepare_with(|generation| async move { self.ready(generation).await.is_some() })
            .await
    }

    pub(super) async fn prepare_with<F: std::future::Future<Output = bool>>(
        &self,
        ready: impl FnOnce(u64) -> F,
    ) -> bool {
        let (generation, owner) = {
            let Ok(mut s) = self.0.lock() else {
                return false;
            };
            if s.closed || s.disabled {
                return false;
            }
            let owner = s.busy.is_none();
            // Empty IDs are forbidden on requests, reserving this slot for shared warm-up.
            if !owner && s.busy.as_deref() != Some("") {
                return false;
            }
            if owner {
                s.busy = Some(String::new());
            }
            (s.generation, owner)
        };
        if !owner {
            for _ in 0..600 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let Ok(s) = self.0.lock() else { return false };
                if s.closed || s.disabled || s.generation != generation {
                    return false;
                }
                if s.busy.as_deref() != Some("") {
                    return s.child.is_some();
                }
            }
            return false;
        }
        let ready = ready(generation).await;
        self.settle(generation, !ready) && ready
    }
}
