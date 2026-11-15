use super::{IvyHost, contracts::*, host::Action};
use std::time::{Duration, Instant};

impl IvyHost {
    pub fn background_probe(&self, resume_only: bool) -> Result<(), IvyErrorCode> {
        if std::env::var_os("STELLAR_BACKGROUND_SMOKE").is_none() {
            return Err(IvyErrorCode::Unavailable);
        }
        self.request(Action::Connect)?;
        println!("STELLAR_SMOKE_STAGE bg-connecting");
        let started = Instant::now();
        loop {
            let snapshot = self.snapshot()?;
            if snapshot.connection == IvyConnectionState::Ready {
                break;
            }
            if snapshot.error.is_some() || started.elapsed() > Duration::from_secs(15) {
                println!("STELLAR_SMOKE_STAGE bg-connect-failed");
                return Err(snapshot.error.unwrap_or(IvyErrorCode::Timeout));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if !resume_only {
            println!("STELLAR_SMOKE_STAGE bg-submitting");
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| IvyErrorCode::Unavailable)?;
            let mut input_id = nonce
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            for index in [20, 16, 12, 8] {
                input_id.insert(index, '-');
            }
            self.request(Action::Submit(IvySubmitRequest {
                version:1, input_id, local_actions: None, voice_utterance: Some(false),
                text: "This is the user's authorized harmless Desktop background notification test. Run exactly one terminal computation in the background with notify_on_complete=true: python -I -c \"sum(i*i for i in range(60000000)); print('STELLAR_BACKGROUND_299')\". Use the existing local interpreter, no downloads. Do not delegate, create or edit files, change settings, access the network, or use other tools. Return a short initial acknowledgement after starting it. When its completion notification wakes you, reply with exactly: STELLAR_BACKGROUND_299 completed. Do not claim completion before the real process finishes.".into(),
            }))?;
        }
        Ok(())
    }
}
