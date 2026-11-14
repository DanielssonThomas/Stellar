use super::issue_contracts::{
    WorkspaceIssuePayload, WorkspaceIssueReference, WorkspaceIssueStatus,
};

fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}

fn references(value: &Option<Vec<WorkspaceIssueReference>>) -> bool {
    value.as_ref().is_none_or(|items| {
        items.len() <= 8
            && items.iter().all(|item| {
                repository(&item.repository) && item.number > 0 && text(&item.title, 240)
            })
            && items.iter().enumerate().all(|(index, item)| {
                !items[..index].iter().any(|other| {
                    other.repository.eq_ignore_ascii_case(&item.repository)
                        && other.number == item.number
                })
            })
    })
}

pub(super) fn payload(raw: &str) -> bool {
    if raw.len() > 16384 {
        return false;
    }
    let Ok(value) = serde_json::from_str::<WorkspaceIssuePayload>(raw) else {
        return false;
    };
    if serde_json::to_value(&value).ok() != serde_json::from_str::<serde_json::Value>(raw).ok() {
        return false;
    }
    let observed = value.observed_at_ms.as_ref().is_none_or(|time| {
        time.parse::<u64>()
            .is_ok_and(|n| n > 0 && n <= 8_640_000_000_000_000 && n.to_string() == *time)
    });
    text(&value.title, 240)
        && repository(&value.repository)
        && value.issue_number > 0
        && value.source
            == format!(
                "https://github.com/{}/issues/{}",
                value.repository, value.issue_number
            )
        && observed
        && match value.status {
            WorkspaceIssueStatus::Ready | WorkspaceIssueStatus::Stale => {
                value.observed_at_ms.is_some()
                    && value.issue.as_ref().is_some_and(|issue| {
                        issue.description.as_ref().is_none_or(|v| text(v, 1200))
                            && issue.workflow_status.as_ref().is_none_or(|v| text(v, 80))
                            && issue.owner.as_ref().is_none_or(|v| text(v, 100))
                            && issue.labels.as_ref().is_none_or(|items| {
                                items.len() <= 24
                                    && items.iter().all(|v| text(v, 80))
                                    && items
                                        .iter()
                                        .enumerate()
                                        .all(|(i, v)| !items[..i].contains(v))
                            })
                            && references(&issue.blockers)
                            && references(&issue.pull_requests)
                    })
            }
            _ => value.issue.is_none() && value.observed_at_ms.is_none(),
        }
}

/// Check issue details without changing the contract of other spatial surfaces.
pub(super) fn spatial(raw: &str) -> bool {
    if !super::workspace_validate::object_payload(raw, 32768) {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let actions_valid = |actions: Option<&serde_json::Value>| {
        actions.and_then(|v| v.as_array()).is_none_or(|actions| {
            actions.iter().all(|action| {
                if action.get("kind").and_then(|v| v.as_str()) != Some("show") {
                    return true;
                }
                let Some(detail) = action.get("panel").and_then(|v| v.get("detail")) else {
                    return true;
                };
                detail.get("surface").and_then(|v| v.as_str()) != Some("github-issue")
                    || detail
                        .get("payload")
                        .is_some_and(|v| payload(&v.to_string()))
            })
        })
    };
    actions_valid(value.get("prepare"))
        && value
            .get("segments")
            .and_then(|v| v.as_array())
            .is_none_or(|segments| {
                segments.iter().all(|segment| {
                    actions_valid(segment.get("actions")) && actions_valid(segment.get("after"))
                })
            })
}
