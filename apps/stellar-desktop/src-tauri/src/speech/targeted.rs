use super::{contracts::*, host::SpeechHost, owned::OwnedSpeech, validation};

impl SpeechHost {
    pub fn stop_request(&self, request: SpeechStopRequest) -> Result<SpeechSnapshot, SpeechError> {
        validation::version(request.version)?;
        let Some(target) = request.target else {
            return self.stop_epoch(&request.epoch);
        };
        let epoch = validation::epoch(&request.epoch)?;
        validation::identity(&target.operation_id)?;
        if target.operation_instance.len() != 32
            || !target
                .operation_instance
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(SpeechError::MalformedRequest);
        }
        let owned = {
            let view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if epoch != view.epoch
                || view.snapshot.operation_id.as_deref() != Some(&target.operation_id)
                || view.snapshot.operation_instance.as_deref() != Some(&target.operation_instance)
            {
                return Ok(view.snapshot.clone());
            }
            view.active
                .as_ref()
                .map(|operation| OwnedSpeech::new(self.clone(), operation.clone()))
        };
        if let Some(owned) = owned {
            owned.stop()?;
        }
        self.snapshot()
    }
}
