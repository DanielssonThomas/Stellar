use super::{contracts::*, journal::PendingLoad, session::Session};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write};

fn bounded(sid: &str) -> bool {
    !sid.is_empty() && sid.len() <= 512 && !sid.chars().any(char::is_control)
}

impl Session {
    pub(super) fn load_retained(&mut self, sid: &str) -> Result<(), IvyErrorCode> {
        if !bounded(sid) {
            return Err(IvyErrorCode::MalformedRequest);
        }
        if self.record.unsettled || self.record.pending_reset.is_some() {
            return Err(IvyErrorCode::Busy);
        }
        if let Some(pending) = &self.record.pending_load {
            if pending.session_id != sid {
                return Err(IvyErrorCode::Uncertain);
            }
        } else {
            self.check_update_switch(sid)?;
            if self.record.workspace.is_none() {
                let created = self.call(
                    "workspace.setup",
                    json!({"descriptor":null,"session_id":self.record.session_id}),
                )?;
                let descriptor = self
                    .broker
                    .as_ref()
                    .ok_or(IvyErrorCode::Unavailable)?
                    .configure_workspace(created)?;
                let mut next = self.record.clone();
                next.workspace = Some(descriptor);
                self.journal.save(&next)?;
                self.record = next;
            }
            // Refuse another surface's live turn or approval before changing the local selection.
            if let Some(current) = &self.record.session_id {
                let before = self.call(
                    "session.resume",
                    json!({"session_id":current,"preserve_policy":true}),
                )?;
                if before["running"] != false
                    || before["pending"] != json!([])
                    || before.get("open_requests").is_some_and(|v| v != &json!([]))
                {
                    return Err(IvyErrorCode::Busy);
                }
            }
            let prepared = self.call("session.load.prepare", json!({"session_id":sid}))?;
            let pending: PendingLoad = serde_json::from_value(json!({
                "request_id":format!("stellar-load-{}-{}", std::process::id(),
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| IvyErrorCode::Unavailable)?.as_nanos()),
                "session_id":prepared["session_id"],"stored_session_id":prepared["stored_session_id"],
                "revision":prepared["revision"],"generation":prepared["generation"],
                "model":prepared["model"],"edit_policy":prepared["edit_policy"],
                "current_session_id":self.record.session_id,
            })).map_err(|_| IvyErrorCode::Protocol)?;
            if pending.session_id != sid || !bounded(&pending.stored_session_id) {
                return Err(IvyErrorCode::Protocol);
            }
            self.archive_selection()?;
            let mut next = self.record.clone();
            next.pending_load = Some(pending);
            self.journal.save(&next)?;
            self.record = next;
        }
        self.finish_retained_load()
    }

    pub(super) fn finish_retained_load(&mut self) -> Result<(), IvyErrorCode> {
        let pending = self
            .record
            .pending_load
            .clone()
            .ok_or(IvyErrorCode::Uncertain)?;
        if !bounded(&pending.session_id)
            || !bounded(&pending.stored_session_id)
            || !bounded(&pending.request_id)
        {
            return Err(IvyErrorCode::Storage);
        }
        let confirmed = self.call(
            "session.load",
            serde_json::to_value(&pending).map_err(|_| IvyErrorCode::Storage)?,
        )?;
        if confirmed["session_id"] != pending.session_id
            || confirmed["stored_session_id"] != pending.stored_session_id
            || confirmed["model"] != pending.model
        {
            return Err(IvyErrorCode::Uncertain);
        }
        let model = match pending.model.as_str() {
            "gpt-6.1-terra" => IvyModel::Terra,
            "gpt-6.1-sol" => IvyModel::Sol,
            _ => return Err(IvyErrorCode::Uncertain),
        };
        self.select_update_store(&pending.session_id)?;
        let mut next = self.record.clone();
        next.session_id = Some(pending.session_id);
        next.input_id = None;
        next.admission_id = None;
        next.generation = None;
        next.model = model;
        next.route_verified = true;
        // Keep the same durable intent through target cursor/lifecycle reconciliation.
        self.journal.save(&next)?;
        self.record = next;
        self.buffered.clear();
        self.replay = None;
        self.shared.update(self.epoch, |view| {
            view.model = model;
            view.verified_model = Some(model);
            view.turn = IvyTurnState::Uncertain;
            view.turn_id = None;
            view.items.clear();
            view.response_segments.clear();
            view.activity.clear();
            view.questions = None;
            view.background_updates = None;
            view.workspace_tools = WorkspaceToolsState::Unavailable;
            view.error = None;
        });
        let pending = self.record.pending_load.take();
        let replayed = super::connection::resume_retained(self);
        self.record.pending_load = pending;
        let completed = replayed.and_then(|()| {
            let mut settled = self.record.clone();
            settled.pending_load = None;
            self.journal.save(&settled)?;
            self.record = settled;
            Ok(())
        });
        self.restore_admission_state();
        completed
    }

    fn select_update_store(&self, target: &str) -> Result<(), IvyErrorCode> {
        let path = self.journal.updates_path();
        if self.record.session_id.as_deref() == Some(target)
            && self
                .record
                .pending_load
                .as_ref()
                .is_some_and(|p| p.session_id == target)
        {
            // Replay may have admitted background work before interruption. Resume that
            // same confirmed selection; fresh switches still require the normal fence.
            super::update_store::Updates::load(&path, target)?;
            return Ok(());
        }
        self.check_update_switch(target)?;
        let archive = path.with_file_name("retained-updates");
        let archived =
            |sid: &str| archive.join(format!("{:x}.json", Sha256::digest(sid.as_bytes())));
        if path.exists() {
            let bytes = fs::read(&path).map_err(|_| IvyErrorCode::Storage)?;
            let raw: Value = serde_json::from_slice(&bytes).map_err(|_| IvyErrorCode::Storage)?;
            let current = raw["session"].as_str().ok_or(IvyErrorCode::Storage)?;
            if current == target {
                return Ok(());
            }
            if Some(current) != self.record.session_id.as_deref() {
                return Err(IvyErrorCode::Uncertain);
            }
            let store = super::update_store::Updates::load(&path, current)?;
            if store.recovery_pending || !store.pending.is_empty() {
                return Err(IvyErrorCode::Uncertain);
            }
            fs::create_dir_all(&archive).map_err(|_| IvyErrorCode::Storage)?;
            let pending = archived(current).with_extension("pending");
            let mut file = fs::File::create(&pending).map_err(|_| IvyErrorCode::Storage)?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| IvyErrorCode::Storage)?;
            drop(file);
            fs::rename(pending, archived(current)).map_err(|_| IvyErrorCode::Storage)?;
        }
        let prior = archived(target);
        let store = super::update_store::Updates::load(&prior, target)?;
        store.save(&path)
    }

    fn archive_selection(&self) -> Result<(), IvyErrorCode> {
        let Some(sid) = self.record.session_id.as_deref() else {
            return Ok(());
        };
        let directory = self
            .journal
            .updates_path()
            .with_file_name("retained-selections");
        fs::create_dir_all(&directory).map_err(|_| IvyErrorCode::Storage)?;
        let path = directory.join(format!("{:x}.json", Sha256::digest(sid.as_bytes())));
        let pending = path.with_extension("pending");
        let mut file = fs::File::create(&pending).map_err(|_| IvyErrorCode::Storage)?;
        let bytes = serde_json::to_vec(&self.record).map_err(|_| IvyErrorCode::Storage)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| IvyErrorCode::Storage)?;
        drop(file);
        fs::rename(pending, path).map_err(|_| IvyErrorCode::Storage)
    }

    fn check_update_switch(&self, target: &str) -> Result<(), IvyErrorCode> {
        let path = self.journal.updates_path();
        for (index, check) in [
            path.clone(),
            path.with_file_name("retained-updates")
                .join(format!("{:x}.json", Sha256::digest(target.as_bytes()))),
        ]
        .into_iter()
        .enumerate()
        {
            if !check.exists() {
                continue;
            }
            if fs::metadata(&check)
                .map_err(|_| IvyErrorCode::Storage)?
                .len()
                > 16_800_000
            {
                return Err(IvyErrorCode::Storage);
            }
            let raw: Value =
                serde_json::from_slice(&fs::read(&check).map_err(|_| IvyErrorCode::Storage)?)
                    .map_err(|_| IvyErrorCode::Storage)?;
            let sid = raw["session"].as_str().ok_or(IvyErrorCode::Storage)?;
            if (index == 1 && sid != target)
                || (sid != target && Some(sid) != self.record.session_id.as_deref())
            {
                return Err(IvyErrorCode::Uncertain);
            }
            let store = super::update_store::Updates::load(&check, sid)?;
            if store.recovery_pending || !store.pending.is_empty() {
                return Err(IvyErrorCode::Uncertain);
            }
        }
        Ok(())
    }
}
