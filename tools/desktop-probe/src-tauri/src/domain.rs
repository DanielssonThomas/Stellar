use crate::contracts::{CaptureState, ProbeError, ProbeReply, ProbeRequest};

pub fn evaluate(request: ProbeRequest) -> Result<ProbeReply, ProbeError> {
    if request.version != 1 {
        return Err(ProbeError::UnsupportedVersion {
            received: request.version,
        });
    }

    let sequence = request
        .sequence
        .parse::<u64>()
        .map_err(|_| ProbeError::InvalidSequence {})?;
    if sequence.to_string() != request.sequence {
        return Err(ProbeError::InvalidSequence {});
    }

    if request
        .device_label
        .as_ref()
        .is_some_and(|label| label.len() > 80)
    {
        return Err(ProbeError::LabelTooLong {});
    }

    let sound_active = match &request.state {
        CaptureState::Idle {} => false,
        CaptureState::Active { rms } => {
            if !rms.is_finite() || !(0.0..=1.0).contains(rms) {
                return Err(ProbeError::InvalidLevel {});
            }
            *rms >= 0.035
        }
    };

    Ok(ProbeReply {
        version: request.version,
        sequence: request.sequence,
        device_label: request.device_label,
        state: request.state,
        sound_active,
    })
}

#[cfg(test)]
#[path = "domain_tests.rs"]
mod domain_tests;
