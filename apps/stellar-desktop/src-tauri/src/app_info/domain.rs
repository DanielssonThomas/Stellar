use super::contracts::{AppCapability, AppInfoError, AppInfoReply, AppInfoRequest};

pub fn app_info(request: AppInfoRequest) -> Result<AppInfoReply, AppInfoError> {
    if request.version != 1 {
        return Err(AppInfoError::UnsupportedVersion {
            received: request.version,
        });
    }

    let sequence = request
        .sequence
        .parse::<u64>()
        .map_err(|_| AppInfoError::InvalidSequence {})?;
    if sequence.to_string() != request.sequence {
        return Err(AppInfoError::InvalidSequence {});
    }

    if request.label.as_ref().is_some_and(|label| label.len() > 80) {
        return Err(AppInfoError::LabelTooLong {});
    }

    Ok(AppInfoReply {
        version: request.version,
        sequence: request.sequence,
        application: "stellar-desktop".to_owned(),
        capabilities: vec![
            AppCapability::NativeWindow {},
            AppCapability::ContractEvents {},
        ],
        label: request.label,
        build_revision: None,
    })
}

#[cfg(test)]
#[path = "domain_tests.rs"]
mod tests;
