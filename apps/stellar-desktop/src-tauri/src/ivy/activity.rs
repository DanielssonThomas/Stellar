use super::{contracts::*, session::Session};
use serde_json::Value;

impl Session {
    pub(super) fn activity(&self, params: &Value) -> Result<(), IvyErrorCode> {
        let actions: Vec<IvyActivity> = serde_json::from_value(
            params
                .pointer("/payload/actions")
                .cloned()
                .ok_or(IvyErrorCode::Protocol)?,
        )
        .map_err(|_| IvyErrorCode::Protocol)?;
        if actions.len() > 12
            || actions
                .iter()
                .any(|row| row.id.len() != 16 || !row.id.bytes().all(|b| b.is_ascii_hexdigit()))
            || actions
                .iter()
                .enumerate()
                .any(|(i, row)| actions[..i].iter().any(|v| v.id == row.id))
        {
            return Err(IvyErrorCode::Protocol);
        }
        self.shared
            .update(self.epoch, |view| view.activity = actions);
        Ok(())
    }
}
