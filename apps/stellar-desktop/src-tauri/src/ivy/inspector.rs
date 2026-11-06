use super::{contracts::IvyErrorCode, inspector_contracts::*, session::Session};
use serde_json::json;

fn bounded(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

fn timestamp(value: &Option<String>) -> bool {
    value
        .as_ref()
        .is_none_or(|v| v.len() <= 64 && chrono::DateTime::parse_from_rfc3339(v).is_ok())
}

pub fn validate_request(request: &IvyInspectorRequest) -> Result<(), IvyErrorCode> {
    if request.version != 1
        || request.offset > 1960
        || request.before_message == Some(0)
        || request
            .session_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || !bounded(id, 512))
    {
        return Err(IvyErrorCode::MalformedRequest);
    }
    Ok(())
}

pub fn inspect(
    session: &mut Session,
    request: IvyInspectorRequest,
) -> Result<IvyInspectorSnapshot, IvyErrorCode> {
    validate_request(&request)?;
    let active = session.record.session_id.clone();
    let result = session.call(
        "inspector.inspect",
        json!({
            "active":active, "requested":request.session_id, "offset":request.offset,
            "before":request.before_message,
        }),
    )?;
    let result: IvyInspectorSnapshot =
        serde_json::from_value(result).map_err(|_| IvyErrorCode::Protocol)?;
    validate_reply(&result)?;
    if result.active_session_id != active || !session.shared.current(session.epoch) {
        return Err(IvyErrorCode::Unavailable);
    }
    session.drain()?;
    Ok(result)
}

pub fn validate_reply(reply: &IvyInspectorSnapshot) -> Result<(), IvyErrorCode> {
    if reply.version != 1
        || !bounded(&reply.observed_at, 64)
        || reply.observed_at.is_empty()
        || reply.sessions.len() > 41
        || reply.messages.len() > 40
        || reply.account.windows.len() > 8
        || reply.next_offset.is_some_and(|value| value > 1960)
        || reply.next_before == Some(0)
        || !timestamp(&Some(reply.observed_at.clone()))
        || !timestamp(&reply.context.observed_at)
        || !timestamp(&reply.account.observed_at)
        || [
            &reply.active_session_id,
            &reply.active_stored_session_id,
            &reply.selected_session_id,
        ]
        .iter()
        .any(|id| {
            id.as_ref()
                .is_some_and(|v| v.is_empty() || !bounded(v, 512))
        })
        || reply.sessions.iter().any(|s| {
            s.id.is_empty()
                || !bounded(&s.id, 512)
                || !bounded(&s.title, 160)
                || s.model.as_ref().is_some_and(|v| !bounded(v, 120))
                || !timestamp(&s.started_at)
                || !timestamp(&s.last_activity_at)
        })
        || reply
            .messages
            .iter()
            .any(|m| m.id == 0 || !bounded(&m.text, 2000) || !timestamp(&m.at))
        || reply.account.windows.iter().any(|w| {
            !bounded(&w.label, 80)
                || !timestamp(&w.reset_at)
                || !matches!(w.scope.as_str(), "account" | "model")
                || w.used_percent
                    .is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v))
        })
        || reply
            .context
            .used
            .zip(reply.context.limit)
            .is_some_and(|(used, limit)| used > limit)
        || reply
            .selected_session_id
            .as_ref()
            .is_some_and(|id| !reply.sessions.iter().any(|s| s.id == *id))
    {
        return Err(IvyErrorCode::Protocol);
    }
    Ok(())
}

#[tauri::command]
pub async fn ivy_inspect(
    host: tauri::State<'_, super::IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvyInspectorSnapshot, IvyErrorCode> {
    let request = serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
        .map_err(|_| IvyErrorCode::MalformedRequest)?;
    let reply = host.inspect(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        reply
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| IvyErrorCode::Timeout)?
    })
    .await
    .map_err(|_| IvyErrorCode::Unavailable)?
}

#[cfg(test)]
#[path = "inspector_tests.rs"]
mod tests;
