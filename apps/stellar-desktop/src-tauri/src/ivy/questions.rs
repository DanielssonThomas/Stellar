use super::{contracts::*, session::Session};
use serde_json::{Value, json};

pub(super) fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

impl Session {
    pub(super) fn question_event(&mut self, params: &Value) -> Result<(), IvyErrorCode> {
        let payload = &params["payload"];
        let id = payload["prompt_id"]
            .as_str()
            .filter(|id| text(id, 512))
            .ok_or(IvyErrorCode::Protocol)?;
        if params["type"] == "clarify.settled" {
            self.shared.update(self.epoch, |view| {
                if let Some(questions) = &mut view.questions {
                    questions.retain(|question| question.id != id);
                }
            });
            return Ok(());
        }
        let question = payload["question"]
            .as_str()
            .filter(|value| text(value, 32768))
            .ok_or(IvyErrorCode::Protocol)?;
        let choices = payload["choices"]
            .as_array()
            .filter(|rows| rows.len() <= 4)
            .ok_or(IvyErrorCode::Protocol)?;
        let choices: Vec<String> = choices
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| text(value, 8192))
                    .map(str::to_owned)
                    .ok_or(IvyErrorCode::Protocol)
            })
            .collect::<Result<_, _>>()?;
        let multi_select = payload["multi_select"]
            .as_bool()
            .ok_or(IvyErrorCode::Protocol)?;
        let current = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if current
            .snapshot
            .questions
            .as_ref()
            .is_some_and(|rows| rows.len() >= 5 && !rows.iter().any(|q| q.id == id))
        {
            return Err(IvyErrorCode::Protocol);
        }
        drop(current);
        self.shared.update(self.epoch, |view| {
            let rows = view.questions.get_or_insert_with(Vec::new);
            if !rows.iter().any(|q| q.id == id) {
                rows.push(IvyQuestion {
                    id: id.into(),
                    text: question.into(),
                    choices,
                    multi_select,
                    shown: false,
                    answering: false,
                });
            }
        });
        Ok(())
    }

    pub(super) fn answer_question(
        &mut self,
        request: IvyQuestionReplyRequest,
    ) -> Result<(), IvyErrorCode> {
        if !self.record.unsettled {
            return Ok(());
        }
        let current = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if !current.snapshot.questions.as_ref().is_some_and(|rows| {
            rows.iter()
                .any(|q| q.id == request.prompt_id && q.shown && q.answering)
        }) {
            return Ok(());
        }
        drop(current);
        let answer = match request.action {
            IvyQuestionAction::Answer { answer } => answer,
            IvyQuestionAction::Skip | IvyQuestionAction::Cancel => String::new(),
            IvyQuestionAction::Shown => return Err(IvyErrorCode::MalformedRequest),
        };
        let sid = self
            .record
            .session_id
            .as_deref()
            .ok_or(IvyErrorCode::Uncertain)?;
        let generation = self.record.generation.ok_or(IvyErrorCode::Uncertain)?;
        let result = self.call("clarify.respond", json!({"session_id":sid,"execution_generation":generation,"prompt_id":request.prompt_id,"answer":answer}))?;
        if !matches!(
            result["status"].as_str(),
            Some("resolved" | "already_resolved")
        ) {
            return Err(IvyErrorCode::Protocol);
        }
        self.shared.update(self.epoch, |view| {
            if let Some(questions) = &mut view.questions {
                questions.retain(|q| q.id != request.prompt_id);
            }
        });
        self.drain()
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::{Arc, Mutex},
    };

    #[test]
    fn answer_uses_the_bound_generation_and_canonical_skip_semantics() {
        for action in [
            IvyQuestionAction::Answer {
                answer: "Left".into(),
            },
            IvyQuestionAction::Skip,
            IvyQuestionAction::Cancel,
        ] {
            let (mut session, directory) = super::super::session_tests::fixture();
            session.shared.update(1, |view| {
                view.questions = Some(vec![IvyQuestion {
                    id: "q1".into(),
                    text: "Which?".into(),
                    choices: vec![],
                    multi_select: false,
                    shown: true,
                    answering: true,
                }])
            });
            let expected = match &action {
                IvyQuestionAction::Answer { answer } => answer.as_str(),
                _ => "",
            };
            let script = format!(
                r#"
while ($line = [Console]::ReadLine()) {{
  $r = $line | ConvertFrom-Json
  if ($r.method -ne 'clarify.respond' -or $r.params.session_id -ne 'session' -or $r.params.execution_generation -ne 3 -or $r.params.prompt_id -ne 'q1' -or $r.params.answer -ne '{expected}') {{ exit 2 }}
  [Console]::WriteLine((@{{id=$r.id;result=@{{status='resolved';prompt_id='q1'}}}} | ConvertTo-Json -Compress -Depth 4))
}}
"#
            );
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(0x08000000);
            session.broker = Some(
                super::super::process::Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap(),
            );
            session
                .answer_question(IvyQuestionReplyRequest {
                    version: 1,
                    prompt_id: "q1".into(),
                    action,
                })
                .unwrap();
            assert!(
                session
                    .shared
                    .view
                    .lock()
                    .unwrap()
                    .snapshot
                    .questions
                    .as_ref()
                    .unwrap()
                    .is_empty()
            );
            drop(session);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
