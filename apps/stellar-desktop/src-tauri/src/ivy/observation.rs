use super::{contracts::IvyErrorCode, session::Session};
use std::time::{Duration, Instant};

const INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct Observation {
    next: Option<Instant>,
}

impl Observation {
    pub(super) fn poll(&mut self, session: &mut Session, now: Instant) -> Result<(), IvyErrorCode> {
        let observing = session.broker.is_some()
            && session.record.unsettled
            && session.record.admission_id.is_some();
        if self.due(now, observing) {
            session.observe_receipt()?;
        }
        Ok(())
    }

    fn due(&mut self, now: Instant, observing: bool) -> bool {
        if !observing {
            self.next = None;
            return false;
        }
        let due = self.next.is_some_and(|next| now >= next);
        if self.next.is_none() || due {
            self.next = Some(now + INTERVAL);
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_requests_continue_observation_without_an_overall_deadline() {
        let mut observation = Observation::default();
        let start = Instant::now();
        assert!(!observation.due(start, true));
        for seconds in 1..=7200 {
            assert_eq!(
                observation.due(start + Duration::from_secs(seconds), true),
                seconds % 30 == 0
            );
        }
    }

    #[test]
    fn settled_or_disconnected_requests_stop_checks_and_new_work_gets_a_fresh_interval() {
        let mut observation = Observation::default();
        let start = Instant::now();
        assert!(!observation.due(start, true));
        assert!(!observation.due(start + INTERVAL, false));
        assert!(!observation.due(start + INTERVAL * 2, true));
        assert!(observation.due(start + INTERVAL * 3, true));
        assert!(!observation.due(start + INTERVAL * 3, true));
    }

    #[cfg(windows)]
    #[test]
    fn attached_request_keeps_running_after_three_minutes_and_recovers_its_final_receipt() {
        use super::super::{contracts::*, recovery_tests::fixture};
        let (mut session, directory) = fixture(
            "$script:checks += 1; if ($request.params.session_id -ne 'session' -or $request.params.admission_id -ne 'admission' -or $request.params.include_result -ne $true) { exit 2 }; if ($script:checks -lt 8) { @{ref=@{session_id='session'};admission_id='admission';execution_generation=3;status='started'} } else { @{ref=@{session_id='session'};admission_id='admission';execution_generation=3;status='terminal';outcome='completed';result=@{final_response='Late answer'}} }",
        );
        session.shared.update(1, |view| {
            view.connection = IvyConnectionState::Ready;
            view.turn = IvyTurnState::Admitted;
        });
        let mut observation = Observation::default();
        let start = Instant::now();
        observation.poll(&mut session, start).unwrap();
        for check in 1..8 {
            observation
                .poll(&mut session, start + INTERVAL * check)
                .unwrap();
            let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
            assert_eq!(snapshot.turn, IvyTurnState::Admitted);
            assert_eq!(snapshot.connection, IvyConnectionState::Ready);
            assert!(snapshot.error.is_none());
            assert!(session.record.unsettled);
            assert!(session.broker.is_some());
        }
        observation
            .poll(&mut session, start + INTERVAL * 8)
            .unwrap();
        assert!(!session.record.unsettled);
        assert_eq!(
            session.shared.view.lock().unwrap().snapshot.turn,
            IvyTurnState::Completed
        );
        assert!(session.broker.is_some());
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn real_transport_failure_is_reported_and_disconnect_stops_observation() {
        let (mut session, directory) = super::super::recovery_tests::fixture("exit 2");
        let mut observation = Observation::default();
        let start = Instant::now();
        observation.poll(&mut session, start).unwrap();
        assert_eq!(
            observation.poll(&mut session, start + INTERVAL),
            Err(IvyErrorCode::Unavailable)
        );
        assert!(session.record.unsettled);
        session.broker = None;
        observation
            .poll(&mut session, start + INTERVAL * 2)
            .unwrap();
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
