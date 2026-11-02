use super::contracts::*;

fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn time(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok() && value.len() <= 35
}
fn optional<T>(value: &Option<T>, f: impl FnOnce(&T) -> bool) -> bool {
    value.as_ref().is_none_or(f)
}
fn identifier(value: &str) -> bool {
    text(value, 64)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn identity(agent: &TelemetryAgent) -> bool {
    match (&agent.source.kind, agent.id.as_str()) {
        (TelemetrySourceKind::HermesTurnLease, id) => matches!(
            (id, agent.name.as_str()),
            ("architect", "Architect")
                | ("architect-cloud", "Architect Cloud")
                | ("foreman", "Foreman")
                | ("foreman-cloud", "Foreman Cloud")
                | ("peon", "Peon")
                | ("peon-cloud", "Peon Cloud")
                | ("mira", "Mira")
                | ("designer", "Designer")
                | ("art-director", "Art Director")
        ),
        (TelemetrySourceKind::CodexLocalTurnHistory, "codex-source") => {
            agent.name == "Codex sessions"
        }
        (TelemetrySourceKind::CodexLocalTurnHistory, id) => {
            id.strip_prefix("codex-").is_some_and(|hash| {
                hash.len() == 16
                    && hash.bytes().all(|b| b.is_ascii_hexdigit())
                    && agent.name == format!("Codex {}", hash[..4].to_ascii_uppercase())
            })
        }
    }
}
fn label(value: &str) -> bool {
    matches!(
        value,
        "Terminal"
            | "Reading files"
            | "Editing files"
            | "Browser"
            | "Web search"
            | "Blender"
            | "VRoid"
            | "Tool invocation"
            | "Processing a turn"
            | "Running a command"
            | "Using a connected tool"
            | "Inspecting an image"
            | "Searching the web"
            | "Coordinating agents"
            | "Generating an image"
            | "Posted an update"
            | "Codex turn in progress"
            | "Session ended with an error"
            | "Session ended"
            | "Turn failed"
            | "Turn completed"
    )
}
fn model(value: &str) -> bool {
    text(value, 100)
        && !value.contains("..")
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(&c))
}
pub fn validate(snapshot: &TelemetrySnapshot) -> bool {
    snapshot.schema_version == 1
        && time(&snapshot.observed_at)
        && snapshot.agents.len() <= 17
        && snapshot.agents.iter().all(|a| {
            identifier(&a.id)
                && identity(a)
                && text(&a.name, 80)
                && optional(&a.session_id, |v| {
                    v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit())
                })
                && a.task.is_none()
                && optional(&a.activity, |v| label(v))
                && optional(&a.tool, |v| label(v))
                && optional(&a.model, |v| model(v))
                && optional(&a.provider, |v| model(v))
                && optional(&a.started_at, |v| time(v))
                && optional(&a.last_observed_at, |v| time(v))
                && time(&a.source.observed_at)
                && a.events.len() <= 41
                && a.events.iter().all(|e| {
                    optional(&e.id, |v| {
                        v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit())
                    }) && optional(&e.at, |v| time(v))
                        && label(&e.label)
                })
        })
}
