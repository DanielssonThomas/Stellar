use super::*;

impl IvyHost {
    pub fn question_reply(
        &self,
        request: IvyQuestionReplyRequest,
    ) -> Result<IvySnapshot, IvyErrorCode> {
        if request.version != 1
            || !super::super::questions::text(&request.prompt_id, 512)
            || matches!(&request.action, IvyQuestionAction::Answer { answer } if !super::super::questions::text(answer, 16384))
        {
            return Err(IvyErrorCode::MalformedRequest);
        }
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let mut view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if view.snapshot.connection != IvyConnectionState::Ready
            || view.snapshot.turn != IvyTurnState::Admitted
        {
            return Ok(view.snapshot.clone());
        }
        let epoch = view.epoch;
        let workspace_epoch = view
            .snapshot
            .workspace_epoch
            .parse()
            .map_err(|_| IvyErrorCode::Protocol)?;
        let Some(question) = view
            .snapshot
            .questions
            .as_mut()
            .and_then(|rows| rows.iter_mut().find(|q| q.id == request.prompt_id))
        else {
            return Ok(view.snapshot.clone());
        };
        if request.action == IvyQuestionAction::Shown {
            question.shown = true;
        } else {
            if !question.shown || question.answering {
                return Ok(view.snapshot.clone());
            }
            self.sender
                .try_send(Work {
                    expression: None,
                    context: None,
                    epoch,
                    workspace_epoch,
                    action: Action::Question(request),
                })
                .map_err(|_| IvyErrorCode::Busy)?;
            question.answering = true;
        }
        drop(view);
        self.shared.update(epoch, |_| {});
        drop(_guard);
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixture;
    use super::*;
    #[test]
    fn question_requires_display_ack_and_accepts_only_one_bound_answer() {
        let (host, receiver) = fixture();
        host.shared.update(0, |view| {
            view.connection = IvyConnectionState::Ready;
            view.turn = IvyTurnState::Admitted;
            view.questions = Some(vec![IvyQuestion {
                id: "q1".into(),
                text: "Which?".into(),
                choices: vec!["Left".into()],
                multi_select: false,
                shown: false,
                answering: false,
            }]);
        });
        let reply = |id: &str, action| IvyQuestionReplyRequest {
            version: 1,
            prompt_id: id.into(),
            action,
        };
        host.question_reply(reply(
            "q1",
            IvyQuestionAction::Answer {
                answer: "Left".into(),
            },
        ))
        .unwrap();
        assert!(receiver.try_recv().is_err());
        assert!(
            host.question_reply(reply("q1", IvyQuestionAction::Shown))
                .unwrap()
                .questions
                .unwrap()[0]
                .shown
        );
        host.question_reply(reply("foreign", IvyQuestionAction::Skip))
            .unwrap();
        host.question_reply(reply("q1", IvyQuestionAction::Skip))
            .unwrap();
        host.question_reply(reply("q1", IvyQuestionAction::Cancel))
            .unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap().action,
            Action::Question(IvyQuestionReplyRequest {
                action: IvyQuestionAction::Skip,
                ..
            })
        ));
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            host.question_reply(reply(
                "q1",
                IvyQuestionAction::Answer {
                    answer: "\0cancelled".into()
                }
            ))
            .unwrap_err(),
            IvyErrorCode::MalformedRequest
        );
    }
}
